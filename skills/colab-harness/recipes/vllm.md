# vLLM: serve a model, use it from anywhere

Prerequisite: a connected session. For gated models, `recipes/setup-hf.md`.

```bash
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ [--max-model-len 8192] [--vllm-args "--enforce-eager"]
node colab.mjs chat "one sentence about ducks" [--max-tokens 200]
node colab.mjs env            # prints OPENAI_BASE_URL and OPENAI_API_KEY for any OpenAI client
node colab.mjs vllm status    # running, ready, model, installed, log tail
node colab.mjs vllm stop
```

- First `start` on a fresh runtime builds a venv with `uv` (vLLM, ninja);
  about 4 minutes. Model load is on top: a 7B AWQ is about 2 minutes.
  `start` blocks until the model answers `/health`.
- `/v1/*` is proxied through the tunnel with the session token as API key,
  streaming included. Scripts on the VM reach it at `VLLM_BASE_URL`
  (`http://127.0.0.1:8000/v1`) with no tunnel in the loop.
- Measured on an L4 with Qwen 2.5 7B AWQ: 45 tok/s single stream through
  the tunnel, 843 tok/s aggregate at 32 concurrent streams.

## Sizing on the L4 (24 GB)

Fits: up to about 14B at AWQ or FP8, 8B at bf16 with a short context.
Gemma 3 12B needs FP8 or AWQ. Keep `--max-model-len` at 8k or under for a
quantized 12B to leave KV cache room.

## Rules

- vLLM reserves 90% of GPU memory. Stop it before `diarize`, `transcribe`,
  or a training script, or run those first.
- Colab is not for serving other tools indefinitely; open a vLLM session,
  use it, `vllm stop` or `release`.
- Failure on start: `vllm status` shows the log tail. "ninja not found"
  means the venv is stale (`run "rm -rf /content/vllm-venv"`, restart);
  a CUDA/torch mismatch means something installed torch into Colab's own
  Python; a fresh runtime fixes it.
