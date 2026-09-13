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

## One-time setup

1. `node colab.mjs init` here. It stores a shared token in
   `~/.colab-harness/token` (mode 600) and does not print it.
2. In any Colab tab, 🔑 Secrets → add `HARNESS_TOKEN` with that value
   (`pbcopy < ~/.colab-harness/token`), notebook access on. Add `HF_TOKEN`
   too if gated Hugging Face models (Gemma, pyannote) are wanted.

An agent must not type the token into the form; it is a credential. The
user pastes it. From then on no secret is ever printed or read from a page.

## Per session

1. Open the notebook straight from GitHub:
   `https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb`
   Runtime → Change runtime type → **L4**. Runtime → **Run all**, then "Run
   anyway" on the GitHub warning. An agent with Claude in Chrome can do these
   clicks itself; only the Drive-mount consent and secrets are for the user.
2. The tunnel cell prints `node colab.mjs connect <url>`. Run it from this
   skill's `scripts/` directory; the stored token is used.
3. Leave the tab open: the last cell is the lease watchdog.

Then, from `scripts/`:

```bash
node colab.mjs status                                   # GPU, jobs, vLLM, lease left
node colab.mjs run "nvidia-smi"                         # any shell command on the VM
node colab.mjs transcribe talk.wav --language es        # faster-whisper large-v3
node colab.mjs script train.py --args "--epochs 1"      # upload + run a script (training, DSPy compile)
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ  # first use builds a venv on the VM (~4 min)
node colab.mjs chat "one sentence about ducks"
node colab.mjs env                                      # OPENAI_BASE_URL / OPENAI_API_KEY for other clients
node colab.mjs keep --minutes 120                       # extend the lease
node colab.mjs release                                  # kill switch: stop vLLM, unassign the runtime
node colab.mjs jobs · job <id> · fetch <id> --out DIR · reload
```

## Lease and kill switch

A forgotten runtime burns compute units, so the VM only stays up while
something holds a lease:

- Every job submission, upload, vLLM start/stop, and `/v1` request renews
  the lease to 30 minutes. Polling (`status`, `job`) does not.
- The watchdog cell checks every minute. Lease expired with no job queued
  or running → it unassigns the runtime. A running job keeps it alive.
- `keep --minutes N` sets a longer lease for long unattended work.
  `release` stops vLLM and unassigns within a minute.
- **Agent rule:** end every task with `release` unless the user asked to keep
  the session, and report the lease left in the final message otherwise.

## Jobs

`transcribe` uploads in 8 MB chunks (the tunnel caps one request body),
waits, downloads `transcription.json` and `transcript.md` into
`colab-jobs/<id>/` or `--out`. Options: `--model`, `--language`,
`--compute-type` (float16 on GPU by default), `--word-timestamps`.

`script` uploads one `.py` or `.sh` and runs it in the job directory with
`--args`, `--env K=V,...`, and optionally `--python /content/vllm-venv/bin/python`.
The script sees `HARNESS_JOB_DIR`, `HARNESS_TOKEN`, `VLLM_BASE_URL`
(`http://127.0.0.1:8000/v1`), and `HF_TOKEN` when the secret exists. Files it
writes into the job directory come back with `fetch`. This is how a QLoRA
run or a DSPy compile against the local vLLM ships: one file, checkpoints
written to the job dir or to Drive.

`vllm start` installs vLLM into `/content/vllm-venv` on first use, so it
never touches Colab's own torch, then blocks until the model is loaded.
`/v1/*` is proxied through the tunnel with the session token as the API
key; streaming works. On the VM itself, scripts reach it at `VLLM_BASE_URL`
with no tunnel in the loop.

## Examples (in `examples/`)

- `train_lora.py`: LoRA fine-tune with TRL and PEFT. Defaults to Qwen2.5
  0.5B Instruct on 300 rows of alpaca-cleaned for 60 steps; `--model`,
  `--dataset`, `--samples`, `--steps`, `--rank`. Saves `adapter/`,
  checkpoints, `train_log.json`, prints a `SUMMARY` line and a sample
  generation. Resumes from a checkpoint in the job dir if one exists.
  `node colab.mjs script examples/train_lora.py --args "--steps 60"`
- `dspy_compile.py`: DSPy BootstrapFewShot on SST-2 sentiment against the
  vLLM on the VM (`VLLM_BASE_URL`), dev accuracy before and after, saves
  `compiled_program.json` and `summary.json`. Needs `vllm start` first.
  `node colab.mjs script examples/dspy_compile.py --args "--train 20 --dev 40"`

Run training before starting vLLM, or stop vLLM first: it reserves 90% of
GPU memory and a trainer will OOM beside it.

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

Against the server running locally on CPU: auth, connect, shell job exit
codes, chunked upload, tiny-model transcription, fetch, script kind, lease
renewal, expiry, busy guard, keep, release. Against a Colab L4 through the
tunnel, opened and run by an agent with Claude in Chrome and no human step:
connect with the stored token, shell job, large-v3 transcription, vLLM in
its venv with a chat completion and measured throughput (Qwen 2.5 7B AWQ:
45 tok/s single stream through the tunnel, 843 tok/s aggregate at 32
streams), hot reload, lease watchdog, release; `examples/train_lora.py`
(Qwen2.5 0.5B, 60 steps in 53 s, adapter fetched) and
`examples/dspy_compile.py` (22 s against the VM's vLLM, compiled program
fetched). Rebuild the notebook and rerun after
changing the server.

## Not yet ported from the jianglens notebooks

Diarization (pyannote, needs an HF token in Colab secrets) and the YouTube
downloader. Both fit as job kinds; the server's `KINDS` table is the seam.
