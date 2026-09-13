# Session: start, connect, keep alive, release, run several

## Start a session

1. Open the notebook straight from GitHub (an agent with Claude in Chrome
   can do all of this itself; only the Drive-consent dialog and the secrets
   are for the user):
   `https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb`
2. Untick `MOUNT_DRIVE` in cell 1 unless the user wants Drive (it needs a
   consent click every runtime). Runtime → Change runtime type → **L4**
   (T4 works, slower). Runtime → **Run all** → "Run anyway" on the GitHub
   warning.
3. Wait for the tunnel cell: it prints `node colab.mjs connect <url>`. Read
   the URL only; nothing else on the page is needed. Then, from `scripts/`:

   ```bash
   node colab.mjs connect <url>          # uses the stored token
   node colab.mjs status                 # GPU, jobs, vLLM, lease left
   ```

4. Leave the notebook tab open: its last cell is the lease watchdog.

Observed timings on an L4: allocation 20 to 40 s, pip and cloudflared about
60 s, so the URL appears about two minutes after Run all. The runtime bills
about 1.54 compute units per hour (L4 High-RAM, measured).

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
