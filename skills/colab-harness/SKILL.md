---
name: colab-harness
description: Use a Google Colab GPU runtime (L4/T4, Colab Pro) as a job server from the local machine through a cloudflared tunnel, no browser automation — faster-whisper transcription, pyannote diarization, YouTube audio download, a vLLM OpenAI-compatible endpoint, LoRA training and DSPy compiles as script jobs. Use when the user asks to run something on Colab, transcribe or diarize audio on a GPU, start vLLM on Colab, train a small model on Colab, or send a batch job to Colab and fetch the results.
---

# colab-harness

A Colab GPU runtime becomes a job server reachable from here. Colab has no
API to start a runtime, so one click stays manual (or is done through the
Claude in Chrome extension); everything after that is HTTP through a tunnel.

```
you: Run all (once per session) ─→ Colab: job server + cloudflared ─→ prints the URL
                                                                        │
local: node colab.mjs connect <url> ←───────────────────────────────────┘
       node colab.mjs pipeline / transcribe / diarize / youtube / vllm / script / run
```

All commands live in `scripts/colab.mjs`. Run `node colab.mjs --help` for
flags. Each task below has one recipe; read only the one you need.

| Task | Recipe |
|---|---|
| First-time setup: the shared token as a Colab secret | `recipes/setup-token.md` |
| Gated Hugging Face models (Gemma, pyannote): HF_TOKEN and terms | `recipes/setup-hf.md` |
| YouTube downloads: the cookie file | `recipes/setup-youtube-cookies.md` |
| Start a session, connect, keep it alive, release it, run several | `recipes/session.md` |
| Transcribe, diarize, download from YouTube, the one-command pipeline | `recipes/transcribe-diarize.md` |
| Serve a model with vLLM and use it from any OpenAI client | `recipes/vllm.md` |
| Run a script on the VM: LoRA training, DSPy compile, anything | `recipes/train-and-scripts.md` |

## Hard rules for an agent

1. **Never type a credential into Colab or read one off a page.** The
   harness token is pasted by the user once; the YouTube cookie file is
   seeded by the user and never opened, printed, or copied by an agent.
2. **A runtime costs compute units every minute.** End every task with
   `node colab.mjs release` unless the user asked to keep it, and while a
   runtime is up keep a session-local check every ~10 minutes
   (`node colab.mjs sessions`). The VM's own lease kills it after 30 idle
   minutes as the backstop.
3. **Do not run a GPU job while vLLM holds the GPU.** vLLM reserves 90% of
   memory; stop it before training or diarizing, or run them first.
4. **Verify outputs, not exits.** A job is done when its files are fetched
   and read; `status` and `job <id>` show state, `fetch` brings files back.

## What runs where

- `scripts/harness_server.py` runs on the VM: `/jobs` (kinds `shell`,
  `script`, `transcribe`, `diarize`, `youtube`), chunked `/uploads`,
  `/vllm/*`, a `/v1/*` proxy, `/lease`, `/shutdown`. Bearer token on every
  route, bound to loopback, reached only through the tunnel.
- `Colab_Harness.ipynb` is generated from the server by
  `scripts/build-notebook.mjs`; edit the server, rebuild, commit, never edit
  the notebook by hand. `node colab.mjs reload` hot-swaps the server on a
  running VM without touching the notebook.
- `examples/train_lora.py` and `examples/dspy_compile.py` are ready-made
  script jobs.

## Limits

- The quick tunnel URL is public but unguessable; the shared token is the
  gate. Cloudflare terminates TLS and can see the traffic; one request body
  is capped near 100 MB, which is why uploads are chunked.
- Colab's rules disallow web-service and remote-control patterns; a job
  server driven while the notebook is open is interactive compute, a vLLM
  left serving other tools is closer to the line. Open and close sessions.
- Everything on the VM disk dies with the runtime. Outputs come back with
  `fetch`; caches persist only if Drive is mounted (consent click) or once
  environment freezing exists (not built yet).

## Verified

All of the above was exercised live on a Colab Pro L4 on 2026-09-13,
including throughput numbers and the kill switch; details per recipe.
Untested: a YouTube download with a valid cookie file, gated models through
vLLM.
