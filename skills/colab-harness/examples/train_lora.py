#!/usr/bin/env python
"""Tiny LoRA fine-tune on a Colab GPU via colab-harness.

    node colab.mjs script examples/train_lora.py --args "--steps 60 --samples 300"

Runs inside the job directory; writes adapter/, checkpoints, train_log.json, and the
training report (training-report.json + REPORT.md): a data ladder, the validation curve,
baselines and a leakage check — see recipes/train-and-scripts.md.
Resumable twice over:
  - same VM: a checkpoint-* dir in the job dir is picked up automatically;
  - new VM (the runtime was reclaimed): pass --ckpt-repo <user>/<repo> and each
    checkpoint is mirrored to that PRIVATE hub repo, then pulled back when the
    job is resubmitted with RESUME=1. Use it with:
      node colab.mjs script examples/train_lora.py --supervise --resume-env RESUME=1 \
        --args "--ckpt-repo <user>/<repo> --save-every 20"
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
p.add_argument("--ckpt-repo", default=os.environ.get("CKPT_REPO", ""),
               help="private hub repo mirroring each checkpoint, so a lost runtime costs only --save-every steps")
p.add_argument("--fractions", default="0.25,0.5,1.0",
               help="data ladder: train a fresh adapter on each fraction and score it, so the trend says "
                    "whether more data is worth buying. '1.0' for a single run.")
p.add_argument("--eval-frac", type=float, default=0.1, help="held-out share of the dataset, scored during training")
a = p.parse_args()
RESUME = os.environ.get("RESUME") == "1"   # set by `colab.mjs script --supervise --resume-env RESUME=1`

# deps: torch is already in Colab; the rest is small
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "trl>=0.20", "peft", "datasets", "accelerate"], check=True)
# Colab ships torchao 0.10, which PEFT refuses (needs >=0.16 or none); LoRA does not use it.
subprocess.run([sys.executable, "-m", "pip", "uninstall", "-q", "-y", "torchao"], check=False)

import torch
from datasets import load_dataset
from huggingface_hub import HfApi, snapshot_download
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
from trl import SFTConfig, SFTTrainer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from train_report import Report   # noqa: E402  (single-file helper; inline it if you upload only one script)

out = Path(os.environ.get("HARNESS_JOB_DIR", ".")).resolve()
print(f"model={a.model} dataset={a.dataset} samples={a.samples} steps={a.steps} out={out}", flush=True)
print("gpu:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "none", flush=True)

# A checkpoint the previous runtime pushed: pull it into this job dir before training.
if RESUME and a.ckpt_repo and os.environ.get("HF_TOKEN"):
    try:
        got = snapshot_download(a.ckpt_repo, token=os.environ["HF_TOKEN"], local_dir=str(out))
        print("RESUMED_FROM", got, sorted(x.name for x in out.glob("checkpoint-*")), flush=True)
    except Exception as e:                      # nothing pushed yet, or no access: start clean
        print("RESUME_UNAVAILABLE", type(e).__name__, str(e)[:160], flush=True)


class MirrorCheckpoints(TrainerCallback):
    """Push every checkpoint off the VM; a failed push must never kill the run."""

    def on_save(self, args, state, control, **kw):
        if not (a.ckpt_repo and os.environ.get("HF_TOKEN")):
            return
        try:
            api = HfApi(token=os.environ["HF_TOKEN"])
            api.create_repo(a.ckpt_repo, private=True, exist_ok=True)
            api.upload_folder(folder_path=str(out), repo_id=a.ckpt_repo, allow_patterns=["checkpoint-*/**"],
                              commit_message=f"checkpoint step {state.global_step}")
            print("CHECKPOINT_PUSHED", state.global_step, flush=True)
        except Exception as e:
            print("CHECKPOINT_PUSH_FAILED", type(e).__name__, str(e)[:160], flush=True)


ds = load_dataset(a.dataset, split=f"train[:{a.samples}]")
def to_messages(row):
    user = row["instruction"] + (("\n\n" + row["input"]) if row.get("input") else "")
    return {"messages": [{"role": "user", "content": user}, {"role": "assistant", "content": row["output"]}]}
ds = ds.map(to_messages, remove_columns=ds.column_names)
split = ds.train_test_split(test_size=a.eval_frac, seed=17)
ds, eval_ds = split["train"], split["test"]
print(f"train={len(ds)} eval={len(eval_ds)} ladder={a.fractions}", flush=True)

tok = AutoTokenizer.from_pretrained(a.model)
model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16, device_map="auto")

lora = LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, task_type="CAUSAL_LM",
                  target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"])

rep = Report(run=f"lora-{Path(a.model).name}", model=a.model, out_dir=out)
rep.config(steps=a.steps, lr=a.lr, rank=a.rank, max_len=a.max_len, fractions=a.fractions, seed=17)
rep.data(train=len(ds), eval=len(eval_ds), dataset=a.dataset, samples=a.samples)
rep.leakage(train_ids=range(len(ds)), eval_ids=[], train_prompts=[x["messages"][0]["content"] for x in ds],
            eval_prompts=[x["messages"][0]["content"] for x in eval_ds])

fractions = [float(f) for f in a.fractions.split(",") if f.strip()]
t0, resume, last_summary = time.time(), False, None
for frac in fractions:
    n = max(8, int(len(ds) * frac))
    steps = max(4, int(a.steps * frac))
    sub = ds.select(range(n))
    cfg = SFTConfig(
        output_dir=str(out / f"stage-{frac}"), max_steps=steps, per_device_train_batch_size=4,
        gradient_accumulation_steps=2, learning_rate=a.lr, logging_steps=5, save_steps=a.save_every,
        save_total_limit=2, bf16=True, max_length=a.max_len, report_to=[], lr_scheduler_type="cosine",
        warmup_steps=max(1, steps // 10), eval_strategy="steps", eval_steps=max(5, steps // 4),
    )
    # A fresh adapter per rung: continuing one model would confound "more data" with "more steps".
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=sub, eval_dataset=eval_ds,
                         processing_class=tok, peft_config=lora)
    trainer.add_callback(MirrorCheckpoints())
    if frac == fractions[0]:
        rep.baseline("untrained", {"eval": {"loss": trainer.evaluate()["eval_loss"]}})
    resume = frac == fractions[0] and any(out.glob("checkpoint-*"))
    trainer.train(resume_from_checkpoint=resume)
    for h in trainer.state.log_history:            # the curve: both splits, during training
        if "loss" in h:
            rep.curve_point(step=h.get("step", 0), split="train", loss=h["loss"])
        if "eval_loss" in h:
            rep.curve_point(step=h.get("step", 0), split="val", loss=h["eval_loss"])
    ev = trainer.evaluate()
    rep.stage(fraction=frac, examples=n, metrics={"eval": {"loss": ev["eval_loss"]}},
              train={"steps": trainer.state.global_step})
    print(f"STAGE frac={frac} n={n} steps={trainer.state.global_step} eval_loss={ev['eval_loss']:.4f}", flush=True)
    log = [x for x in trainer.state.log_history if "loss" in x]
    last_summary = {"model": a.model, "dataset": a.dataset, "samples": n, "fraction": frac,
                    "steps": trainer.state.global_step, "resumed": resume, "ckpt_repo": a.ckpt_repo or None,
                    "first_loss": log[0]["loss"] if log else None, "last_loss": log[-1]["loss"] if log else None,
                    "eval_loss": ev["eval_loss"], "train_seconds": round(time.time() - t0, 1)}

trainer.model.save_pretrained(out / "adapter")   # the adapter from the full-data rung
tok.save_pretrained(out / "adapter")
summary = {**last_summary, "adapter": str(out / "adapter")}
(out / "train_log.json").write_text(json.dumps({"summary": summary, "log": trainer.state.log_history}, indent=2))
rep.cost(gpu=torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu", seconds=time.time() - t0)
rep.write()
print("SUMMARY", json.dumps(summary), flush=True)

# smoke test: one generation with the adapter
model.eval()
msgs = [{"role": "user", "content": "Give three tips for staying focused while studying."}]
enc = tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True).to(model.device)
with torch.no_grad():
    gen = model.generate(**enc, max_new_tokens=80, do_sample=False)
print("SAMPLE:", tok.decode(gen[0][enc["input_ids"].shape[1]:], skip_special_tokens=True).strip()[:400], flush=True)
print("=== TRAIN COMPLETE ===")
