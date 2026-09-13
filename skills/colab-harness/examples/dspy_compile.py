#!/usr/bin/env python
"""Tiny DSPy compile against the vLLM running on the same Colab VM.

    node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ
    node colab.mjs script examples/dspy_compile.py --args "--train 20 --dev 40"

Optimises a sentiment classifier (SST-2) with BootstrapFewShot, reports
dev accuracy before and after, saves compiled_program.json in the job dir.
"""
import argparse, json, os, subprocess, sys, time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--model", default=None, help="model name as served by vLLM; default: first model listed")
p.add_argument("--train", type=int, default=20)
p.add_argument("--dev", type=int, default=40)
p.add_argument("--max-demos", type=int, default=4)
a = p.parse_args()

subprocess.run([sys.executable, "-m", "pip", "install", "-q", "dspy>=2.6", "datasets"], check=True)
import dspy, requests
from datasets import load_dataset

base = os.environ["VLLM_BASE_URL"]; key = os.environ["HARNESS_TOKEN"]
out = Path(os.environ.get("HARNESS_JOB_DIR", ".")).resolve()
model = a.model or requests.get(base + "/models", headers={"Authorization": f"Bearer {key}"}, timeout=30).json()["data"][0]["id"]
print(f"vllm={base} model={model} train={a.train} dev={a.dev}", flush=True)
lm = dspy.LM(f"openai/{model}", api_base=base, api_key=key, temperature=0.0, max_tokens=200, cache=False)
dspy.configure(lm=lm)

ds = load_dataset("stanfordnlp/sst2", split="validation").shuffle(seed=7)
labels = ["negative", "positive"]
rows = [dspy.Example(sentence=r["sentence"], sentiment=labels[r["label"]]).with_inputs("sentence") for r in ds.select(range(a.train + a.dev))]
train, dev = rows[:a.train], rows[a.train:]

class Classify(dspy.Signature):
    """Classify the sentiment of a movie review sentence."""
    sentence: str = dspy.InputField()
    sentiment: str = dspy.OutputField(desc="one word: positive or negative")

program = dspy.ChainOfThought(Classify)
metric = lambda ex, pred, trace=None: ex.sentiment == str(pred.sentiment).strip().lower().strip(".")
evaluate = dspy.Evaluate(devset=dev, metric=metric, num_threads=8, display_progress=False)

t0 = time.time()
before = float(evaluate(program))
print(f"dev accuracy before: {before:.1f}% ({time.time()-t0:.0f}s)", flush=True)

t1 = time.time()
opt = dspy.BootstrapFewShot(metric=metric, max_bootstrapped_demos=a.max_demos, max_labeled_demos=a.max_demos)
compiled = opt.compile(program, trainset=train)
after = float(evaluate(compiled))
print(f"dev accuracy after:  {after:.1f}% (compile+eval {time.time()-t1:.0f}s)", flush=True)

compiled.save(str(out / "compiled_program.json"))
summary = {"model": model, "train": a.train, "dev": a.dev, "before": before, "after": after,
           "demos": len(getattr(compiled.predict, "demos", [])), "seconds": round(time.time() - t0, 1)}
(out / "summary.json").write_text(json.dumps(summary, indent=2))
print("SUMMARY", json.dumps(summary), flush=True)
print("=== COMPILE COMPLETE ===")
