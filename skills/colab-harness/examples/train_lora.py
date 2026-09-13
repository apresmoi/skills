#!/usr/bin/env python
"""Tiny LoRA fine-tune on a Colab GPU via colab-harness.

    node colab.mjs script examples/train_lora.py --args "--steps 60 --samples 300"

Runs inside the job directory; writes adapter/, checkpoints, train_log.json.
Resumable: if a checkpoint-* dir exists in the job dir, training resumes from
it, so a killed runtime only loses the steps since the last save.
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
p.add_argument("--dataset", default="yahma/alpaca-cleaned")
p.add_argument("--samples", type=int, default=300)
p.add_argument("--steps", type=int, default=60)
p.add_argument("--save-every", type=int, default=20)
p.add_argument("--lr", type=float, default=2e-4)
p.add_argument("--rank", type=int, default=16)
p.add_argument("--max-len", type=int, default=512)
a = p.parse_args()

# deps: torch is already in Colab; the rest is small
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "trl>=0.20", "peft", "datasets", "accelerate"], check=True)

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer

out = Path(os.environ.get("HARNESS_JOB_DIR", ".")).resolve()
print(f"model={a.model} dataset={a.dataset} samples={a.samples} steps={a.steps} out={out}", flush=True)
print("gpu:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none", flush=True)

ds = load_dataset(a.dataset, split=f"train[:{a.samples}]")
def to_messages(row):
    user = row["instruction"] + (("\n\n" + row["input"]) if row.get("input") else "")
    return {"messages": [{"role": "user", "content": user}, {"role": "assistant", "content": row["output"]}]}
ds = ds.map(to_messages, remove_columns=ds.column_names)

tok = AutoTokenizer.from_pretrained(a.model)
model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16, device_map="auto")

cfg = SFTConfig(
    output_dir=str(out), max_steps=a.steps, per_device_train_batch_size=4, gradient_accumulation_steps=2,
    learning_rate=a.lr, logging_steps=5, save_steps=a.save_every, save_total_limit=2, bf16=True,
    max_length=a.max_len, report_to=[], lr_scheduler_type="cosine", warmup_ratio=0.1,
)
lora = LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=lora)

resume = any(out.glob("checkpoint-*"))
t0 = time.time()
trainer.train(resume_from_checkpoint=resume)
trainer.model.save_pretrained(out / "adapter")
tok.save_pretrained(out / "adapter")

log = [x for x in trainer.state.log_history if "loss" in x]
summary = {"model": a.model, "dataset": a.dataset, "samples": a.samples, "steps": trainer.state.global_step,
           "resumed": resume, "first_loss": log[0]["loss"] if log else None, "last_loss": log[-1]["loss"] if log else None,
           "train_seconds": round(time.time() - t0, 1), "adapter": str(out / "adapter")}
(out / "train_log.json").write_text(json.dumps({"summary": summary, "log": log}, indent=2))
print("SUMMARY", json.dumps(summary), flush=True)

# smoke test: one generation with the adapter
model.eval()
msgs = [{"role": "user", "content": "Give three tips for staying focused while studying."}]
ids = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt").to(model.device)
with torch.no_grad():
    gen = model.generate(ids, max_new_tokens=80, do_sample=False)
print("SAMPLE:", tok.decode(gen[0][ids.shape[1]:], skip_special_tokens=True).strip()[:400], flush=True)
print("=== TRAIN COMPLETE ===")
