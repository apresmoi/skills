---
name: colab-harness
description: Use a Google Colab GPU runtime (L4/T4, Colab Pro) as a job server from the local machine — transcription with faster-whisper, arbitrary shell jobs, and a vLLM OpenAI-compatible endpoint — through a cloudflared quick tunnel, with no browser automation. Use when the user asks to run something on Colab, transcribe audio on a GPU, start vLLM on Colab, or send a batch job to Colab and fetch the results.
---

# colab-harness — a Colab GPU as a job server, driven from here

Colab has no API to start a runtime, so one thing stays manual: open the
notebook and press Run all. Everything after that is HTTP through a tunnel.

```
you: Run all (once per session) ─→ Colab: job server + cloudflared ─→ prints connect line
                                                                          │
local: node colab.mjs connect <url> <token> ←─────────────────────────────┘
       node colab.mjs transcribe / run / vllm start / chat / fetch
```

## Per session

1. Open the notebook in Colab straight from GitHub:
   `https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb`
2. Runtime → Change runtime type → **L4** (or T4). Runtime → **Run all**.
   First cell asks to mount Drive: say yes so model caches persist.
3. The tunnel cell prints `node colab.mjs connect <url> <token>`. Run it here,
   from this skill's `scripts/` directory. The session lands in
   `~/.colab-harness/session.json` (mode 600).
4. Leave the notebook tab open. Its last cell loops so Colab keeps the
   session alive; closing it or Runtime → Disconnect ends everything.

Then, from `scripts/`:

```bash
node colab.mjs status                                   # GPU, jobs, vLLM
node colab.mjs run "nvidia-smi"                         # any shell command on the VM
node colab.mjs transcribe talk.wav --language es        # faster-whisper large-v3
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ  # installs vllm on first use
node colab.mjs chat "one sentence about ducks"
node colab.mjs env                                      # OPENAI_BASE_URL / OPENAI_API_KEY for other clients
node colab.mjs jobs · job <id> · fetch <id> --out DIR
```

`transcribe` uploads in 8 MB chunks (the tunnel caps a single request body),
waits, and downloads `transcription.json` and `transcript.md` into
`colab-jobs/<id>/` or `--out`. Options: `--model`, `--language`,
`--compute-type` (float16 on GPU by default), `--word-timestamps`.

`vllm start` blocks until the model is loaded. `/v1/*` is proxied through the
same tunnel with the session token as the API key, so any OpenAI client works
with the two variables `env` prints. Streaming is supported.

## What runs on the VM

`scripts/harness_server.py`, embedded into the notebook by
`scripts/build-notebook.mjs`. Edit the server, rebuild, commit; never edit
the notebook by hand. Routes: `/health`, `/uploads` (chunked), `/jobs`
(kinds `shell`, `transcribe`), `/vllm/start|stop|status`, `/v1/{path}`
proxy. One GPU job at a time; a bearer token gates every route. Server binds
to loopback; only the tunnel reaches it.

## Limits and rules

- The quick tunnel is public but unguessable; the token is the real gate and
  rotates every session. Cloudflare terminates TLS and can see the traffic.
- Cloudflare's free proxy caps one request at about 100 MB and origin
  response start at about 100 s; uploads are chunked and jobs are async, so
  neither bites. No uptime promise: if the tunnel dies, rerun the tunnel cell
  and `connect` again.
- Colab's rules disallow web-service and remote-control patterns. A job
  server you drive while the notebook is open is interactive compute;
  leaving vLLM up as a service for other tools is closer to the line. Open
  and close vLLM sessions; don't leave them running.
- Colab Pro sessions end on idle and on the runtime cap. Persist anything
  you care about: outputs come back through `fetch`, model caches live on
  Drive under `MyDrive/colab-harness/_hf_home`.
- `run` gives arbitrary shell on the VM. It is your VM, but treat commands
  from untrusted sources as you would locally.

## Verified

Full loop exercised against the server running locally on CPU (auth 401,
connect, shell job exit codes, chunked upload, tiny-model transcription,
fetch) and against a Colab L4 through the tunnel. Rebuild the notebook and
rerun both after changing the server.

## Not yet ported from the jianglens notebooks

Diarization (pyannote, needs an HF token in Colab secrets) and the YouTube
downloader. Both fit as job kinds; the server's `KINDS` table is the seam.
