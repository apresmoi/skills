# External coding-engine contract

The external-engine boundary applied to the four locally installed
subscription CLIs: `agy`, `grok`, `codex`, and `claude`.

## Reusable boundary

1. Build a complete prompt inside the primary runtime.
2. Start a fresh external CLI process in the intended workspace.
3. Use CLI isolation controls without copying credentials; preserve native login
   storage when required (Claude uses its saved subscription/keychain sign-in).
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

**Claude Code** (tested v2.1.269; require this version or later) —
non-interactive `--print --output-format json`, `--max-turns`, and the runner
timeout. `--max-turns` is accepted but absent from `claude --help` in 2.1.269;
if a later version drops it the launch fails loudly with an unknown-option
error rather than running unbounded. `--safe-mode --restricted` skips ordinary customizations and confines
built-in file tools to the working directory; managed policy still applies.
`--no-session-persistence` disables resumable transcripts. Empty MCP config
plus `--strict-mcp-config` excludes ambient servers. Safe mode disables skills,
hooks, CLAUDE.md, and auto-memory; include relevant project rules in the prompt.
This is not an OS sandbox. Never use `--bare`, which skips OAuth/keychain login.
The child clears `CLAUDECODE` so this skill also works when hosted by Claude.

Run `agy --help`, `agy models`, `grok --help`, `grok models`,
`codex --help`, `codex exec --help`, and `claude --help` before changing flags or model
identifiers. CLI contracts are external dependencies.

## Authentication boundary — all subscriptions, never API keys

Check presence and login state without exposing values. `consult.mjs`
implements this as a preflight (`--check` to run it standalone): binary on
PATH plus login-record presence/mtime; it honours `$ANTIGRAVITY_CLI_HOME`,
`$GROK_HOME`, and `$CODEX_HOME`. Token expiry is not checked — a present but
expired record fails at launch, in the engine's stderr. Claude instead checks
its saved subscription via auth status as described below. Never print or copy
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

- **Claude**: `claude --safe-mode --restricted auth status --json`, capped at
  15 seconds. Require `loggedIn: true`, `authMethod: "claude.ai"`, and
  `apiProvider: "firstParty"`. Discard raw auth stdout/stderr; retain only
  pass/fail and a non-secret explanation. Re-auth with `claude auth login`.
  Preserve `CLAUDE_CONFIG_DIR` and native keychain access. Clear API/provider
  and auth-token environment overrides for both preflight and launch, including
  `CLAUDE_CODE_OAUTH_TOKEN`; this adapter supports saved subscription sign-in.
  It never reads or copies credential files. A successful status check does not
  prove an unexpired token or available quota; verify an actual completed run.

## Consultation versus implementation

Consultation is the safe default:

- AGY: plan mode plus its sandbox.
- Grok: plan permission mode, no memory, no web, no subagents.
- Codex: `--sandbox read-only --disable memories`, `approval_policy="never"`.
  (`--disable memories` is `features.memories=false`; Codex memories are
  cross-session and written by every run.)

- Claude: expose and pre-approve only `Read,Glob,Grep` with `--tools` and
  `--allowedTools`; `--permission-mode dontAsk --permission-prompts none`
  denies anything needing interactive approval. No shell, editing, or subagents.

Implementation is an explicit escalation that grants substantial authority:

- AGY: accept-edits mode with automatic permission approval.
- Grok: auto permission mode with automatic approval.
- Codex: `--sandbox workspace-write`, `approval_policy="never"`.

- Claude: add `Edit,Write,Bash` to both tool lists. Bash is unsandboxed; use
  an isolated worktree. Restricted mode can still deny protected configuration
  writes; report denials rather than bypassing the restriction.

Use one writer per worktree, inspect the resulting diff, and run authoritative
project tests afterward.

## Output and failure handling

Capture stdout and stderr separately. Strip terminal escape sequences. Retain
the raw report long enough to audit synthesis, but do not treat a clean exit as
proof that claims are correct.

Claude retains raw run JSON in `claude.result.json`, extracts the textual
`result` into `claude.md`, and requires a successful result envelope and a
non-empty report ending with `=== REPORT COMPLETE ===`. The runner adds that
sentinel instruction. Empty/malformed/error/turn-limited or incomplete results
fail even when the process exits 0. Raw auth status is never saved there.

Classify failures precisely: executable absent; login missing or expired; model
identifier unavailable; timeout; permission denial; process failure with
stderr; empty or malformed final output.

Do not silently substitute one engine for another. Their independence is the
reason to consult more than one.

Claude invocation and authentication references: [CLI reference](https://code.claude.com/docs/en/cli-reference), [authentication](https://code.claude.com/docs/en/authentication).
