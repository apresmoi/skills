# External coding-engine contract

The external-engine boundary applied to the three locally installed
subscription CLIs: `agy`, `grok`, and `codex`.

## Reusable boundary

1. Build a complete prompt inside the primary runtime.
2. Start a fresh external CLI process in the intended workspace.
3. Give it an isolated runtime home while staging only required authentication.
4. Disable ambient cross-session memory unless continuity is intentional.
5. Capture and clean the final textual output (strip terminal escapes).
6. Return duration plus text to the primary runtime.
7. Keep memory, scheduling, social delivery, and final authority outside the
   external CLI.

## Current local invocation contracts

**Grok** — prompt file, bounded turn count, no cross-session memory, disabled
web search, no subagents, plain output, explicit cwd and permission mode.
Prefer locally configured defaults unless a task requires a pinned model.

**AGY** (Antigravity CLI, v1.1.13) — non-interactive `--print` mode with a
timeout, a fresh `--new-project`, the workspace added via `--add-dir`, and an
explicit `--mode`. Avoid pinning model display labels in portable automation.

**Codex** (codex-cli 0.147.0) — non-interactive `codex exec`. The sandbox is
the safety boundary: `--sandbox read-only` for consultation,
`--sandbox workspace-write` for authorized edits, `danger-full-access` only
when externally sandboxed. `-c approval_policy="never"` keeps exec fully
non-interactive; `-C <dir>` sets the working root; `-m <model>` picks the model.

Run `agy --help`, `agy models`, `grok --help`, `grok models`,
`codex --help`, and `codex exec --help` before changing flags or model
identifiers. CLI contracts are external dependencies.

## Authentication boundary — all subscriptions, never API keys

Check presence and login state without exposing values. `consult.mjs`
implements this as a preflight (`--check` to run it standalone): binary on
PATH plus login-record presence/mtime; it honours `$ANTIGRAVITY_CLI_HOME`,
`$GROK_HOME`, and `$CODEX_HOME`. Token expiry is not checked — a present but
expired record fails at launch, in the engine's stderr. Never print or copy
token contents into prompts, reports, repositories, or diagnostic output.

- **Grok**: `~/.grok` or `$GROK_HOME`; login record `auth.json`. Full expiry
  requires `grok login`.
- **Antigravity CLI (agy)**: `~/.gemini/antigravity-cli` or
  `$ANTIGRAVITY_CLI_HOME`; login record `antigravity-oauth-token`. App state may
  also live under `$ANTIGRAVITY_HOME`, macOS
  `~/Library/Application Support/Antigravity`, `~/.config/Antigravity`, or
  `~/.antigravity`. AGY can refresh an expired access token while its refresh
  token is valid.
- **Codex**: `~/.codex/auth.json` (OAuth / ChatGPT subscription sign-in);
  non-secret config in `~/.codex/config.toml`. Re-auth with `codex login`.

## Consultation versus implementation

Consultation is the safe default:

- AGY: plan mode plus its sandbox.
- Grok: plan permission mode, no memory, no web, no subagents.
- Codex: `--sandbox read-only`, `approval_policy="never"`.

Implementation is an explicit escalation that grants substantial authority:

- AGY: accept-edits mode with automatic permission approval.
- Grok: auto permission mode with automatic approval.
- Codex: `--sandbox workspace-write`, `approval_policy="never"`.

Use one writer per worktree, inspect the resulting diff, and run authoritative
project tests afterward.

## Output and failure handling

Capture stdout and stderr separately. Strip terminal escape sequences. Retain
the raw report long enough to audit synthesis, but do not treat a clean exit as
proof that claims are correct.

Classify failures precisely: executable absent; login missing or expired; model
identifier unavailable; timeout; permission denial; process failure with
stderr; empty or malformed final output.

Do not silently substitute one engine for another. Their independence is the
reason to consult more than one.
