---
name: harness-coding-agents
description: Harness the locally installed subscription coding CLIs — Antigravity (`agy`), Grok (`grok`), and Codex (`codex`) — as bounded external agents for analysis, review, alternative solutions, adversarial checks, or explicitly authorized implementation. Use when the user asks to harness grok, run agy, use codex, consult Antigravity, get a second opinion or model council, delegate a work packet to an external agent. These CLIs drive paid SUBSCRIPTION logins (no API keys).
---

# Harness AGY, Grok, and Codex

Treat `agy`, `grok`, and `codex` as bounded external collaborators. They all run
on the user's paid **subscriptions** (never API keys): `agy` uses Antigravity
OAuth, `grok` uses `~/.grok/auth.json`, `codex` uses `~/.codex/auth.json`. Keep
the calling agent responsible for scope, verification, and the final answer.

All three CLIs must be installed on PATH and logged in (see preflight below). This skill is self-contained: `scripts/consult.mjs` shells out to each,
captures cleaned stdout/stderr per engine, and never uses a shell.

## Run the workflow

1. Define one concrete question or work packet. Include the relevant paths,
   constraints, expected output, and a request to distinguish evidence from
   inference.
2. Default to consultation mode. Do not authorize edits unless the user asked
   for implementation.
3. Exclude credentials, private keys, tokens, and unrelated private context
   from the prompt. CLI arguments and captured output may be locally visible.
4. Preflight. The runner checks, per requested engine, that the binary is on
   PATH and its login record exists (presence and mtime only, never contents),
   prints one `[preflight] ok|FAIL <engine>` line each to stderr, and does NOT
   launch a failing engine. To check without running anything:

   ```bash
   node scripts/consult.mjs --check --engine all
   ```

   Nonzero exit = at least one engine is not ready; the FAIL line names the
   missing executable or the `<cli> login` to run. Never substitute another
   engine for a failed one — report the gap.
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

   Consultation prompts must be runnable WITHOUT shell access for AGY/Grok:
   their plan modes may deny every command tool. Pre-generate what the task
   needs (e.g. `git diff > /abs/path/stack.patch`) and reference those
   absolute paths in the prompt. Do NOT tell Codex to avoid shell commands —
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
   and neither CLI has a native report-to-file flag.)
7. Synthesize only the useful evidence. Identify which engine supplied each
   important lead when provenance matters.

Engine selection: `--engine agy|grok|codex` for one consultant, a comma list
(`--engine grok,codex`), `--engine both` (agy+grok), or `--engine all`
(agy+grok+codex). Use `--out-dir` to persist reports somewhere other than a
temp dir. Run `node scripts/consult.mjs --help` for all options.

## Consultation vs implementation (per engine)

Consultation is the safe default — read-only, no ambient memory:

- **AGY**: `--mode plan --sandbox`.
- **Grok**: `--permission-mode plan --no-memory --disable-web-search --no-subagents`.
- **Codex**: `codex exec --sandbox read-only --disable memories` with
  `approval_policy="never"`. Codex keeps cross-session memories by default,
  read and written by every run; disabling them is what keeps a review
  independent of an earlier implementation run.

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

Override per engine with `--agy-model`, `--grok-model`, `--codex-model`. Do not
pin display labels in portable automation — installed catalogs change. Run
`agy models`, `grok models`, and `codex --help` before changing flags or model
identifiers. CLI contracts are external dependencies.

## Deeper contract

Read [references/harness-contract.md](references/harness-contract.md) when
changing invocation flags, authentication staging, model selection, isolation,
or output cleanup. It records the external-engine boundary this skill applies
to all three CLIs.

If a CLI is missing or its login record is absent, the runner's preflight
reports it and skips that engine; `summary.json` carries the `preflight`
array. An expired-but-present login is NOT caught by preflight — it surfaces
as a login error in `<engine>.stderr.txt`. Do not inspect, print, copy, or
commit credential contents.
