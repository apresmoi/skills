# Scripts on the VM: LoRA training, DSPy compile, anything

The `script` kind uploads one `.py` or `.sh`, runs it in a job directory on
the VM, streams nothing back until it ends, then fetches whatever it wrote.

```bash
node colab.mjs script my_job.py [--args "--epochs 1 --lr 2e-4"] [--env K=V,K2=V2] [--python /content/vllm-venv/bin/python] [--out DIR] [--all]
```

The script sees `HARNESS_JOB_DIR` (write outputs here), `HARNESS_TOKEN`,
`VLLM_BASE_URL`, and `HF_TOKEN` when the secret exists. Exit non-zero to
fail the job; stdout/stderr come back as `stdout.txt` / `stderr.txt`.
Directories are fetched recursively; `checkpoint-*` folders are skipped
unless `--all`. Default timeout 6 h (`--timeout` seconds).

## LoRA fine-tune: `examples/train_lora.py`

```bash
node colab.mjs script examples/train_lora.py --args "--model Qwen/Qwen2.5-0.5B-Instruct --dataset yahma/alpaca-cleaned --samples 300 --steps 60"
```

TRL + PEFT, bf16, rank 16. Writes `adapter/`, checkpoints every 20 steps,
`train_log.json`, prints a `SUMMARY` line and a sample generation, ends with
`=== TRAIN COMPLETE ===`. Resumes from a checkpoint if the job dir has one.
Measured: 60 steps on 300 rows in 53 s on an L4, loss 2.29 → 1.08, adapter
35 MB fetched. Removes Colab's incompatible `torchao` first; that is
expected output, not an error.

Sizing on the L4: QLoRA up to about 14B, LoRA bf16 up to about 4B. A 12B
QLoRA on 10k examples is 3 to 6 hours, 5 to 9 compute units.

## DSPy compile: `examples/dspy_compile.py`

```bash
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ
node colab.mjs script examples/dspy_compile.py --args "--train 20 --dev 40"
```

BootstrapFewShot on SST-2 sentiment against the VM's own vLLM; prints dev
accuracy before and after, writes `compiled_program.json`, `summary.json`.
Measured: 22 s on an L4 with 4 demos. Swap the signature, metric, and
dataset for a real task; keep `dspy.LM("openai/<model>", api_base=VLLM_BASE_URL, api_key=HARNESS_TOKEN)`.

## Writing your own

- Print progress and end with a sentinel line so the log is self-verifying.
- Save checkpoints and results under `HARNESS_JOB_DIR`; nothing else on the
  VM survives the runtime.
- Long runs: `node colab.mjs keep --minutes 240` first, and note the lease
  never expires while the job is running anyway.
- GPU-heavy scripts and vLLM cannot share the L4; see the rule in `recipes/vllm.md`.
