---
name: colab-harness
description: Use a Google Colab GPU runtime (L4/T4, Colab Pro) as a job server driven entirely from the local machine through a cloudflared tunnel — faster-whisper transcription, pyannote diarization, YouTube audio download, a vLLM OpenAI-compatible endpoint, LoRA training pushed to private Hugging Face repos, DSPy compiles, and a catalog of what was trained. The agent starts the runtime itself (headless Playwright by default, or Claude in Chrome) and finds its URL itself; after one-time setup the user only says what to run. Use when the user asks to run, train, transcribe, diarize, or serve something on Colab, or asks what models were trained.
---

# colab-harness

After one-time setup (three secrets, see the setup recipes) the user's whole
instruction is "run X on Colab". Everything else is the agent's job:

```
       you: "run the training on colab" ←───────┐
                        ↓                       │
      agent: node colab.mjs check               │
                        ↓                       │
  no runtime → node colab.mjs start             │
  (playwright headless, or the agent in Chrome) │
                        ↓                       │
  Colab: fresh VM, fresh random tunnel URL,     │
  published to a private HF dataset repo        │ next task: same, from zero
                        ↓                       │
      agent: node colab.mjs connect             │
             (finds the URL itself)             │
                        ↓                       │
      jobs: script --push / transcribe / vllm   │
                        ↓                       │
      agent: node colab.mjs release ────────────┘
```

**Start every task with `node colab.mjs check`.** Every prerequisite comes
back as OK, WARN or MISSING with its fix, then the runtimes that are up or
published, then the next command. Exit 0: something to use. 1: configured,
start a runtime. 2: setup incomplete; do the MISSING items in this order:
`recipes/setup-token.md`, `recipes/setup-hf.md`, `recipes/setup-starter.md`
(YouTube cookies only when a download is needed). Anything that fails after
that: `recipes/troubleshooting.md`, indexed by the exact error text.

Why there is a "start the runtime" step at all: Colab has no API to
allocate a VM, so a browser must click Run all once per session, and every
session gets a new random tunnel address. Both are absorbed: `start` does
the click through the configured *starter* (playwright: the skill's own
cookie-seeded Chrome profile, headless; chrome: the agent driving the
Claude in Chrome extension), and the notebook publishes the address to
`<hf-user>/colab-harness-state` (private) so `connect` needs no argument.
Never ask the user for a URL. Ask once which starter they prefer if none is
set; accept "this one in chrome" / "this one in playwright" as `--via`.

All commands live in `scripts/colab.mjs`; `node colab.mjs --help` lists
them. Each task below has one recipe; read only the one you need.

| Task | Recipe |
|---|---|
| First-time setup: the shared token as a Colab secret | `recipes/setup-token.md` |
| How runtimes get started: the starter preference (playwright, headless, cookie-seeded / chrome), Google auth by cookie export, debugging lost auth | `recipes/setup-starter.md` |
| Hugging Face token: gated models (Gemma, pyannote) and pushing adapters to private repos | `recipes/setup-hf.md` |
| YouTube downloads: the cookie file | `recipes/setup-youtube-cookies.md` |
| Start a session, connect, keep it alive, survive a lost runtime (`--supervise`), release it, run several | `recipes/session.md` |
| Something failed: every error text seen so far, its cause and fix | `recipes/troubleshooting.md` |
| Transcribe, diarize, download from YouTube, the one-command pipeline | `recipes/transcribe-diarize.md` |
| Serve a model with vLLM and use it from any OpenAI client | `recipes/vllm.md` |
| Run a script on the VM: LoRA training, DSPy compile, anything; what a run must report (data ladder, validation curve, baselines, uncertainty); keep the result with `--push` (private HF repo); checkpoint/resume so a lost runtime costs minutes; the catalog of trained models (`models list/search/show`) | `recipes/train-and-scripts.md` |

## Hard rules for an agent

1. **Never type a credential into Colab or read one off a page.** The
   harness token is pasted by the user once; the YouTube cookie file is
   seeded by the user and never opened, printed, or copied by an agent.
   Google auth for the playwright starter is a cookie export the user
   installs with `auth install`; same rules as the YouTube file. Reading
   the tunnel URL off the notebook page is allowed but no longer needed.
2. **A runtime costs compute units every minute.** Before starting a
   session or a long job, state the cost: `connect` prints the GPU's rate
   as units per hour and as a share of the monthly allowance; `keep
   --dry-run --minutes N` prices a stretch of time; `cost` shows this
   month's total and the balance. End every task with `node colab.mjs
   release` (it prints the session's cost) unless the user asked to keep
   it, and while a runtime is up keep a session-local check every ~10
   minutes (`node colab.mjs sessions`). The VM's own lease kills it after
   30 idle minutes as the backstop.
3. **Do not run a GPU job while vLLM holds the GPU.** vLLM reserves 90% of
   memory; stop it before training or diarizing, or run them first.
4. **Collect before you stop.** `release` drains finished jobs it has not fetched and
   refuses while one is running; an idle-release watchdog must also hold while a transfer
   is in flight. The VM's disk is gone the moment it unassigns.
5. **Verify outputs, not exits.** A job is done when its files are fetched
   and read; `status` and `job <id>` show state, `fetch` brings files back.
   For progress on running jobs use `progress` (chat-friendly lines with
   bars), `--follow` (stream one job's log), or `ui` (the VM's dashboard).
6. **Training reports, not loss numbers.** Every fine-tune trains partially first — a
   25/50/100% data ladder — and reports the validation curve, both baselines (untrained and
   trivial), bootstrap intervals, a leakage check and its cost, via
   `examples/train_report.py`. Without the ladder you cannot say whether more data would
   help; without the curve you cannot say whether it overfitted; without intervals a
   6-point gap on a small eval set looks like progress. `recipes/train-and-scripts.md`.
7. **A long job must survive losing its runtime.** Colab can reclaim the VM
   mid-run whatever the lease says (seen: a 76-minute fine-tune killed at 46
   minutes, all of it lost). For anything over ~30 minutes, make the script
   checkpoint to a private hub repo and run it with `script … --supervise
   --resume-env …`, which renews the lease, restarts a dead runtime and
   resubmits in resume mode. `recipes/session.md` and
   `recipes/train-and-scripts.md` have both halves; one without the other
   only buys a restart from zero.

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

Exercised live on Colab Pro on 2026-09-13: every job kind, vLLM throughput,
the kill switch, YouTube with a real cookie file, `--push` to a private
Hugging Face repo with the catalog card, `models sync` from the hub, and
the full zero-touch loop with the playwright starter (headless start,
secret prompts answered, bare `connect`, `release`). Not yet verified: gated
models through vLLM, and the streamed `fetch` retry against a slow tunnel.
