# Session: start, connect, keep alive, release, run several

## Start a session

`node colab.mjs check` first. If it says READY, skip to the jobs. If it says
NO RUNTIME:

1. `node colab.mjs start` (add `--via chrome` or `--via playwright` to
   override the preference, `--gpu T4` for a cheaper card). With the
   playwright starter this is headless and prints the tunnel URL after
   about two minutes; the process stays alive in the background holding
   the notebook tab open for the lease watchdog and exits when the runtime
   is gone (log: `~/.colab-harness/start.log`). With the chrome starter the
   agent does the clicks itself: open the notebook link in a fresh tab,
   Runtime → Change runtime type → **L4**, Run all, "Run anyway".
   Auth or starter problems: `recipes/setup-starter.md`.
2. About two minutes later the notebook has published its tunnel URL to
   `<hf-user>/colab-harness-state` (private dataset repo, using the
   `HF_TOKEN` secret). Then, from `scripts/`:

   ```bash
   node colab.mjs connect                # finds the published URL; needs a local HF login (hf auth login)
   node colab.mjs connect <url>          # fallback: the URL printed by cell 4
   node colab.mjs status                 # GPU, jobs, vLLM, lease left
   ```

   `connect` skips runtimes already bound to another session, retires
   published records that no longer answer, and prints the cost rate.
3. Leave the notebook tab open: its last cell is the lease watchdog, and it
   also retires the published URL when the runtime goes down.

Observed timings on an L4: allocation 20 to 40 s, pip and cloudflared about
60 s, so the URL is published about two minutes after Run all. The runtime
bills about 1.54 compute units per hour (L4 High-RAM, measured).

## Keep alive and release

- Every job submission, upload, vLLM start/stop and `/v1` request renews
  the lease to 30 minutes; polling (`status`, `job`) does not. When the
  lease expires with no job running, the watchdog unassigns the runtime.
- `node colab.mjs keep --minutes 120` for long unattended work.
- `node colab.mjs release` stops vLLM and unassigns the runtime within a
  minute. Confirm: `status` fails, the tunnel returns 530.
- **Agent rule:** while a runtime is up, schedule a session-local check
  every ~10 minutes that runs `node colab.mjs sessions`, reports lease and
  jobs, and releases when nothing is pending. Delete the check once the
  runtime is gone. End every task with `release` unless told otherwise.

## Cost: units, allowance, balance

Colab Pro gives 100 compute units a month; the GPU rate is what the
Resources panel shows as "Usage rate". The CLI keeps a local ledger
(`~/.colab-harness/ledger.json`): one entry per connected session with its
GPU, rate, start, and end, so cost is rate × time with no guessing about
job durations.

```bash
node colab.mjs connect <url>            # prints: ≈1.54 units/h → 1.5% of 100/month per hour
node colab.mjs keep --minutes 120 --dry-run   # prices the time before committing to it
node colab.mjs status                   # ≈ units this session so far
node colab.mjs cost                     # this month's sessions, total, % of allowance, balance
node colab.mjs budget set --monthly 100 --available 499.86   # seed the balance from the Resources panel
node colab.mjs budget rate --gpu "Tesla T4" --units-per-hour 1.44   # record a measured rate
```

Rates: the L4 (High-RAM) figure, 1.54 units/h, was measured on 2026-09-13.
T4 and A100 figures are estimates until measured: open Runtime → View
resources on a session of that type, read "Usage rate", and record it with
`budget rate`. Sessions ended by the lease rather than `release` are closed
in the ledger the next time `sessions` or `cost` finds them unreachable,
using the last time the CLI saw them, so their cost can be slightly
underestimated; `release` is exact.

### Estimating a job before running it

`units = rate × hours`. On the L4 at 1.54 units/h that is 0.026 units per
minute, so a 10-minute job costs ≈0.26 units, 0.26% of the month. Measured
on 2026-09-13, L4, including cold model loads:

| Step | Time | L4 units |
|---|---|---|
| Runtime allocation + notebook setup | ~2 min | 0.05 |
| faster-whisper large-v3, cold load + 19 s clip | 18 s | 0.01 |
| large-v3, warm, per hour of audio (≈15 to 20× realtime) | 3 to 4 min | 0.10 |
| pyannote venv build (first use per runtime) | ~1 min | 0.03 |
| pyannote 3.1 diarization, per hour of audio | ~2 to 3 min | 0.07 |
| YouTube download, 19 s clip incl. Deno install | ~30 s | 0.01 |
| vLLM venv build (first use per runtime) | ~4 min | 0.10 |
| vLLM 7B AWQ model load | ~2 min | 0.05 |
| vLLM serving, per hour up | 60 min | 1.54 |
| LoRA example, 0.5B, 60 steps on 300 rows | 53 s | 0.02 |
| QLoRA 12B on ~10k examples (estimate) | 3 to 6 h | 5 to 9 |
| DSPy compile example, 20 train / 40 dev | 22 s | 0.01 |

Rule of thumb: everything short lives in the rounding error; the cost is
the runtime being up. A session where you transcribe five hour-long
recordings costs about the 25 minutes of work plus whatever idle time you
leave before `release`, so release promptly and use the lease watchdog as
the backstop. A T4 is roughly 40% slower on these workloads at a similar
rate, so per job it costs slightly more; an A100 is 3 to 5× faster at 5 to
8× the rate, so it only pays for latency, not for units.

**Agent rule:** quote the per-hour cost when a session starts and the
`keep --dry-run` figure before extending a lease or launching a job
expected to take longer than 30 minutes. Report the session cost on
release.

## Watching progress

- `--follow` on `run`, `script`, `transcribe`, `diarize`, `youtube`, or
  `pipeline` streams the job's stdout and stderr to the terminal while
  waiting. Scripts that print `step 12/60` or `45%` lines are the ones worth
  following.
- `node colab.mjs progress` prints one line per queued or running job across
  every saved session: kind, id suffix, elapsed, a bar when the last log line
  carries `n/m` or `n%`, and that line. This is what an agent pastes into
  the chat when asked how things are going.
- `node colab.mjs ui` opens the VM's own dashboard at `<tunnel>/ui`: GPU,
  lease countdown with keep and release buttons, vLLM state, the job list,
  and a live log tail for the selected job. It is one HTML page served by
  the job server; paste the harness token into it once (it stays in that
  browser's localStorage). Works from a phone through the same tunnel.

## Several runtimes

Every command takes `--session <name>` (or `COLAB_SESSION=<name>`); the
default is `default`. One name is one runtime, saved in
`~/.colab-harness/sessions/<name>.json`. Colab Pro allows more than one
runtime at a time, each billed separately. Open the notebook once per
runtime (a second tab gets a second runtime).

```bash
node colab.mjs connect <url-1> --session train
node colab.mjs connect <url-2> --session serve
node colab.mjs sessions                   # each session: up/unreachable, GPU, lease, vLLM
node colab.mjs release --session train
```

## Hot reload

After editing `scripts/harness_server.py` locally, `node colab.mjs reload`
pushes it to the VM and restarts the server in place; the tunnel and the
session stay valid. Rebuild the notebook too (`node scripts/build-notebook.mjs`)
so the next fresh session starts from the same code.

## If the tunnel dies

Cloudflare quick tunnels have no uptime promise. Rerun cell 4 in the
notebook, it prints a new URL; `connect` again. Jobs and files on the VM
survive.
