# Troubleshooting, by symptom

Run `node colab.mjs check` first: it names what is missing and the fix.
Every item below was hit for real; the fix is what made it pass.

## Starting a runtime (`start`)

| Symptom | Cause | Fix |
|---|---|---|
| `start failed: Google auth missing or expired` / `AUTH_EXPIRED` | The cookie-seeded profile no longer signs in | Send the user `node colab.mjs auth`; they re-export from google.com and run `auth install` |
| `auth install` refuses: no `SID` / `__Secure-1PSID` | Exported from the Colab page; login cookies live on `.google.com` | Export from https://www.google.com/ while logged in |
| `auth install`: "cookies did not sign in" | Export taken logged out, or from an account without Colab Pro | Re-export as the right account |
| The user got logged out of Google in their own Chrome | Full cookie export was seeded (per-service cookies included); Google killed the session everywhere | Never seed the full export; `auth install` seeds only the core `.google.com` login cookies and touches google.com first. The user signs back in once and re-exports |
| `SECRET_MISSING: the notebook could not read HARNESS_TOKEN` | Secret absent, notebook access off, or the "Grant access" prompt was not answered | recipes/setup-token.md; the starter answers the prompt itself, so a persistent failure is the secret |
| `TIMEOUT: no tunnel URL after N min` | Cells did not run to cell 4. Seen causes: Drive mount waiting for consent (old notebook), a dialog left open, an unanswered secret prompt | `~/.colab-harness/start.log` shows every dialog it saw; `start --headed` shows the window; `~/.colab-harness/start-error.png` is the last screen on error. Then `node scripts/colab-start.mjs stop` to kill the half-started runtime |
| `COLAB: Cannot connect to GPU backend` | No GPU of that type free, or the allowance is spent | Retry later, or `start --gpu T4` |
| `could not click "..."` | A Colab dialog kept intercepting | The starter dismisses known dialogs and retries; a new dialog text needs adding to `dismissDialogs` in `scripts/colab-start.mjs` |
| A T4 came up although L4 was asked | Runtime-type dialog did not take | `start.log` should say `runtime type: L4`; if not, rerun; the starter picks by radio name |
| `profile in use` / a second start fails to launch Chrome | The previous starter process still holds the profile (it stays alive while its runtime lives) | That runtime is up: `connect` to it, or `release` it and wait for the process to exit |
| The notebook Colab ran is an older version | Colab caches GitHub notebooks opened by branch | `start` opens by commit SHA (`git ls-remote`); when offline it falls back to `main`, so push first |

## Connecting (`connect`, `check`)

| Symptom | Cause | Fix |
|---|---|---|
| `connect: no runtime published` | No runtime up, or the notebook could not publish (no `HF_TOKEN` secret) | `check`; the local starter's runtime is found without the hub via `~/.colab-harness/last-start.json` |
| `GET /health → 401` right after a start | The notebook fell back to a one-off token: the `HARNESS_TOKEN` secret was not readable | recipes/setup-token.md, then `release`/`stop` and start again |
| `cannot reach ...: ENOTFOUND` or the tunnel returns 530 | The runtime is gone (released, lease expired, Colab idle limit) | `check` closes the ledger entry; `start` again |
| The Claude in Chrome extension says "not connected" | The extension and this terminal are on different claude.ai accounts | Use `start --via playwright`, or sign the extension into the terminal's account |
| `check` says `starter: MISSING` | No preference saved | Ask the user once; `config set starter playwright|chrome` |

## Jobs

| Symptom | Cause | Fix |
|---|---|---|
| `fetch <file>: stalled (no bytes for 60 s) three times` | The quick tunnel throttled (seen at 50 KB/s) | Files stay on the VM; retry `fetch <id>` later; anything pushed is on the hub |
| `youtube` fails with `COOKIE_EXPIRED` | YouTube rejected the session | recipes/setup-youtube-cookies.md, steps 2 and 3 |
| `diarize`: `could not load pyannote/...: accept its terms` | Terms not accepted for that account, or no `HF_TOKEN` | recipes/setup-hf.md |
| `diarize` mentions matplotlib backend, torchaudio or CUDA | Colab's inline matplotlib backend leaked into the worker | Already forced to `Agg` in the server; `reload` if the VM runs an old server |
| `--push` dies: `HF_TOKEN is a read token and cannot write` | Read-scope token in the secret | Write token, recipes/setup-hf.md; `reload` after changing the secret |
| `push refused: <repo> exists and is PUBLIC` | Safety: a private push would land in a public repo | Another name, or `--public` on purpose |
| `vllm start` fails: `ninja not found`, or torch/CUDA mismatch | Half-built venv, or vLLM installed into Colab's own python | `vllm status` log tail; the server builds vLLM in its own uv venv with ninja; a fresh runtime resets it |
| Training prints torchao removal lines | Colab's torchao is incompatible with PEFT | Expected output, not an error |
| A GPU job hangs while vLLM runs | vLLM reserves 90% of the GPU | `vllm stop` first, or run GPU jobs before serving |
| The server on the VM is older than `scripts/harness_server.py` | Started from a cached notebook | `node colab.mjs reload` hot-swaps it |

## Cost and cleanup

| Symptom | Cause | Fix |
|---|---|---|
| A runtime is still up after a task | `release` not run, or a start that never connected | `node colab.mjs release` when connected; otherwise `node scripts/colab-start.mjs stop` terminates every session of the account via Manage sessions |
| `cost` shows a session with no end | Ended by the lease, not by `release` | Closed the next time `check`/`sessions` finds it unreachable |
| Rate unknown for a GPU | Only the L4 was measured (1.54 u/h) | `budget rate --gpu "<name>" --units-per-hour N` from Runtime → View resources |
