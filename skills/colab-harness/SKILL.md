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

Requirements: Node 18+ on this machine; a Google account with **Colab Pro**
(the L4 and longer sessions; the free tier's T4 works but disconnects
sooner); nothing to install on the Colab side, the notebook does it.

1. Generate the shared token here. It is written to `~/.colab-harness/token`
   (mode 600) and never printed:

   ```bash
   cd <this skill>/scripts && node colab.mjs init
   pbcopy < ~/.colab-harness/token        # macOS; on Linux: xclip -sel clip < ~/.colab-harness/token
   ```

2. Store it as a Colab secret. Open any notebook in Colab, for example the
   harness notebook itself:
   `https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb`
   In the **left sidebar** click the 🔑 key icon ("Secrets"), then
   **+ Add new secret**. Name `HARNESS_TOKEN`, Value: paste. Switch on the
   **Notebook access** toggle on that row. Secrets are per Google account,
   so this is done once for every notebook you run.
3. Optional: add `HF_TOKEN` the same way (a Hugging Face read token) for
   gated models such as Gemma and pyannote. The notebook passes it to the
   server when present.
4. Verify: run the notebook once (see Per session). Cell 1 prints
   `token: from Colab secret HARNESS_TOKEN`. If it prints `generated for this
   session` instead, the secret is missing or its notebook-access toggle is
   off; the notebook then falls back to a one-off token and prints it with
   the URL, which still works for that session.

What the token is: a shared secret between `colab.mjs` and the job server
on the VM. It is not a Google credential. Rotate it with
`node colab.mjs init --force` and update the Colab secret.

An agent must never type the token into the Secrets form: it is a
credential, and the user pastes it. The agent can open the panel and fill
the name, nothing more.

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

## Several runtimes at once: named sessions

Every command takes `--session <name>` (or `COLAB_SESSION=<name>`); the
default is `default`. Each name is one Colab runtime with its own URL and
lease, stored in `~/.colab-harness/sessions/<name>.json`. Colab Pro allows
more than one runtime at a time, each billed separately.

```bash
node colab.mjs connect <url-1> --session train
node colab.mjs connect <url-2> --session serve
node colab.mjs script examples/train_lora.py --session train
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ --session serve
node colab.mjs sessions          # each saved session, reachable or not, lease, vLLM model
node colab.mjs release --session train
```

Run one notebook per runtime (open the same notebook twice; Colab assigns a
new runtime to each tab). `sessions` is the place to look before ending a
task: every line that says `up` is still billing.

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

`youtube <url>` downloads audio on the VM with yt-dlp (mono 16 kHz wav) and
fetches `metadata.youtube.json`; the wav stays on the VM unless
`--fetch-audio`. Cookies: YouTube blocks Colab's IPs without a logged-in
session, so keep a Netscape `cookies.txt` at
`~/.colab-harness/youtube-cookies.txt`. The CLI uploads it per job and the
VM deletes it when the job ends; nothing is stored in Drive or secrets. When
YouTube refuses, the job fails with `COOKIE_EXPIRED` and the user re-exports
the file. **An agent never reads, prints, or moves that file**; it asks the
user to seed it, same rule as the deep-research skill's cookies.

`diarize <audio | --from-job ID>` runs pyannote speaker-diarization-3.1 in
its own venv on the VM and fetches `dump.json` (raw turns) and
`grouped.json` (turns of the same speaker merged across gaps under 3 s), the
jianglens formats. Setup, one-time, on the Hugging Face account behind the
`HF_TOKEN` secret: accept the terms on the `pyannote/speaker-diarization-3.1`
and `pyannote/segmentation-3.0` model pages.

`transcribe --from-job ID --diarization JOB` reuses a file already on the
VM and labels each segment with the speaker of largest overlap, so
`transcript.md` reads `[00:01:02 → 00:01:09] SPEAKER_00: …`.

`pipeline <url | audio>` chains the three: download or upload, diarize,
transcribe with speakers, and fetches every JSON plus the transcript into
one folder. `--language`, `--speakers N`, `--out DIR` pass through.

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
fetched); `diarize` on a two-voice clip (pyannote 3.1, correct turns);
`transcribe --diarization` (every segment labelled correctly); `pipeline`
on a local file (23 s end to end); `youtube` without cookies fails with the
`COOKIE_EXPIRED` hand-off as designed. Untested: a YouTube download with a
valid cookie file, and gated models such as Gemma through vLLM. Rebuild the notebook and rerun after
changing the server.

## Adding a job kind

The server's `KINDS` table maps a kind name to a function taking the job
dict; `input_job` and `upload_id` handling is shared, so a new kind only
needs to read `job["input"]` and write files into `job["dir"]`.
