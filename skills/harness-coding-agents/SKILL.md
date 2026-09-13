---
name: harness-coding-agents
description: Harness the locally installed subscription coding CLIs — Antigravity (`agy`), Grok (`grok`), Codex (`codex`), and Claude Code (`claude`) — as bounded external agents for analysis, review, alternative solutions, adversarial checks, or explicitly authorized implementation. Use when the user asks to harness grok, run agy, use codex, harness Claude Code, consult Antigravity, get a second opinion or model council, delegate a work packet to an external agent. These CLIs drive paid SUBSCRIPTION logins (no API keys).
---

# Harness AGY, Grok, Codex, and Claude

Treat `agy`, `grok`, `codex`, and `claude` as bounded external collaborators. They all run
on the user's paid **subscriptions** (never API keys): `agy` uses Antigravity
OAuth, `grok` uses `~/.grok/auth.json`, `codex` uses `~/.codex/auth.json`, and
`claude` uses its saved Claude subscription sign-in. Keep the calling agent responsible for scope, verification, and the final answer.

Requested CLIs must be installed on PATH and logged in (see preflight below).
Claude requires Claude Code v2.1.269 or later. This skill is self-contained:
`scripts/consult.mjs` starts each CLI without a shell and captures cleaned
stdout/stderr per engine.

## Run the workflow

1. Define one concrete question or work packet. Include the relevant paths,
   constraints, expected output, and a request to distinguish evidence from
   inference.
2. Default to consultation mode. Do not authorize edits unless the user asked
   for implementation.
3. Exclude credentials, private keys, tokens, and unrelated private context
   from the prompt. CLI arguments and captured output may be locally visible.
4. Preflight. The runner checks, per requested engine, that the binary is on
   PATH and its login record exists (presence and mtime only, never contents).
   Claude instead runs a bounded `claude auth status --json` check for a saved
   subscription login; raw account details are discarded. The runner prints
   one `[preflight] ok|FAIL <engine>` line each to stderr, and does NOT
   launch a failing engine. To check without running anything:

   ```bash
   node scripts/consult.mjs --check --engine all
   ```

   Nonzero exit = at least one engine is not ready; the FAIL line names the
   missing executable or the login command to run (`claude auth login` for
   Claude). Never substitute another engine for a failed one — report the gap.
5. Invoke `scripts/consult.mjs` from this skill directory:

   ```bash
   node scripts/consult.mjs \
     --engine all \
     --cwd /absolute/path/to/project \
     --prompt-file /absolute/path/to/prompt.md
   ```

6. Read the emitted `<engine>.md` reports. FIRST check each report is
   non-empty and actually ends with conclusions — exit code 0 does NOT mean a
   usable report. Observed failure modes: AGY consultation auto-denies
   permissions it cannot prompt for in headless plan mode and emits nothing —
   observed for both `command` AND `read_file`, i.e. AGY is effectively unusable
   for headless consultation unless the user adds allow-rules to settings.json
   (check its `.stderr.txt`, which names the denied permission); Grok can stop
   after its opening sentence with exit 0, especially on large multi-file
   packets — give it a narrower scope and more `--max-turns`. On an
   empty/truncated report, re-run that engine with the fix below rather than
   treating silence as "no findings". Then verify material claims against the
   repository, tests, or primary sources. Explain disagreements instead of
   resolving them by vote.

   A complete report is not proof the engine could read. Observed: with
   Codex's Code Mode host missing, file reads failed closed, yet Codex exited
   0 and produced a confident, well-sourced-looking report built on nothing.
   Require file/line citations and spot-check at least one against the repo
   before trusting a report; a citation that doesn't exist means the engine
   was blind.

   Consultation prompts must be runnable WITHOUT shell access for AGY/Grok/Claude:
   AGY/Grok plan modes may deny every command tool; Claude exposes only file
   reads. Pre-generate what the task needs (e.g. `git diff > /abs/path/stack.patch`) and reference those
   absolute paths in the prompt. For Claude, stage referenced evidence inside
   `--cwd`; restricted file tools cannot read outside it. The prompt file itself
   may be elsewhere because the runner reads it. Do NOT tell Codex to avoid shell commands —
   its read-only sandbox READS files via sandboxed shell (`cat`/`rg`), so a
   no-shell rule blinds it entirely (it will honestly refuse). Scope the
   restriction per engine: "read files however your sandbox allows; do not
   modify anything".
   For truncated Grok output, raise `--max-turns` and narrow the packet.
   If Grok reports that the prompt was truncated or offloaded, split the evidence
   into smaller inline review packets; otherwise its turns may be spent paging
   the prompt instead of completing the review.

   Completeness contract: consultation prompts must require the report to END
   with a literal sentinel line (e.g. `=== REPORT COMPLETE ===`). Trust a
   report only if the sentinel is present; a sentinel-less report is
   truncated — retry it, don't read silence as "no findings". (Engines cannot
   write report files themselves: consultation mode is read-only by design,
   and the runner captures their reports.)
   For Claude, the runner adds the sentinel instruction and rejects malformed,
   empty, unsuccessful, turn-limited, or incomplete results. The textual report
   is in `claude.md`; `claude.result.json` retains run metadata for diagnosis.
   If Claude emitted no JSON (for example on timeout), that raw file can be
   empty or malformed; check `summary.json` and `claude.stderr.txt` as well.
   If a Claude review times out without a report, bound the next attempt to the
   relevant source supplied inline, disable tools with `--tools ""`, and use
   `--effort medium --output-format stream-json --verbose` in a monitored runner.
   Preserve the same subscription/auth and isolation flags. Require the final
   sentinel; initialization and file-read activity alone are not a review verdict.
7. Synthesize only the useful evidence. Identify which engine supplied each
   important lead when provenance matters.

Engine selection: `--engine agy|grok|codex|claude` for one consultant, a comma list
(`--engine grok,codex`), `--engine both` (agy+grok), or `--engine all`
(agy+grok+codex+claude). The default remains `both`. Use `--out-dir` to persist
reports somewhere other than a temp dir. Run `node scripts/consult.mjs --help` for all options.

## Consultation vs implementation (per engine)

Consultation is the safe default — read-only, no ambient memory:

- **AGY**: `--mode plan --sandbox`.
- **Grok**: `--permission-mode plan --no-memory --disable-web-search --no-subagents`.
- **Codex**: `codex exec --sandbox read-only --disable memories` with
  `approval_policy="never"`. Codex keeps cross-session memories by default,
  read and written by every run; disabling them is what keeps a review
  independent of an earlier implementation run.
- **Claude**: `--safe-mode --restricted`, only `Read,Glob,Grep` exposed and
  pre-approved, `--permission-mode dontAsk --permission-prompts none`, empty
  MCP configuration, and `--no-session-persistence`. Ordinary customizations
  (including hooks, skills, CLAUDE.md, and auto-memory) are disabled; managed
  policy still applies. Include necessary project instructions in the packet.
  Never use `--bare`: it skips subscription and keychain authentication.

## Authorize writes deliberately

Pass `--write` only when the user explicitly requested file changes. Write mode
requires exactly one engine:

```bash
node scripts/consult.mjs --engine codex --write --cwd "$PWD" --prompt "Implement the bounded change..."
```

Write-mode escalations:

- **AGY**: `--mode accept-edits --dangerously-skip-permissions`.
- **Grok**: `--permission-mode auto --always-approve`.
- **Codex**: `codex exec --sandbox workspace-write` with `approval_policy="never"`.
- **Claude**: adds `Edit,Write,Bash` to the exposed and pre-approved tools.
  Bash is unsandboxed; use an isolated worktree and verify the resulting diff
  and tests yourself. Restricted file tools stay within the working directory;
  this is not an OS sandbox.

Before write mode:

- Start from a clean or understood worktree.
- Give each engine a disjoint worktree or disjoint path ownership.
- Never run two engines concurrently against the same writable worktree; the
  runner rejects `--write` with more than one engine.
- Review the diff and run the real project gates yourself. An external
  engine's success claim is not completion proof.

## Preserve independence

Give every engine the same raw task when seeking independent opinions. Do not
include one engine's conclusions in another's prompt unless performing an
explicit critique round. Prefer one initial pass per engine, followed by a
targeted critique only when a concrete uncertainty remains.

Keep consultations bounded: ask for a verdict, findings ordered by severity,
file/line evidence, uncertainties, and suggested verification commands.

## Model selection

Override per engine with `--agy-model`, `--grok-model`, `--codex-model`, or
`--claude-model`. `--max-turns` bounds Grok and Claude (default 24). Do not
pin display labels in portable automation — installed catalogs change. Run
`agy models`, `grok models`, `codex --help`, and `claude --help` before
changing flags or model identifiers. CLI contracts are external dependencies.
Claude model environment preferences are preserved; `--claude-model` overrides
the primary model. Auth/provider overrides are handled separately below.

## Deeper contract

Read [references/harness-contract.md](references/harness-contract.md) when
changing invocation flags, authentication staging, model selection, isolation,
or output cleanup. It records the external-engine boundary this skill applies
to all four CLIs.

If a CLI is missing or its login check fails, the runner's preflight
reports it and skips that engine; `summary.json` carries the `preflight`
array. Claude uses its saved subscription sign-in and preserves
`CLAUDE_CONFIG_DIR`; API/provider/auth-token environment overrides (including
`CLAUDE_CODE_OAUTH_TOKEN`) are cleared for that child process. Re-authenticate
with `claude auth login`. No credential files are read or copied by the runner.
For the other engines, an expired-but-present login is NOT caught by preflight
— it surfaces as a login error in `<engine>.stderr.txt`. Do not inspect, print, copy, or
commit credential contents.
