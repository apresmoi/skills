---
name: deep-research
description: Run any deep-research prompt through a logged-in ChatGPT Pro or Grok (SuperGrok) session in a real Chrome, wait for the report (15–60 min), and capture it into an intake file — plus named research exercises (spread timelines on X, claim checks, origin attribution) that render a tuned prompt on demand. Use when the user asks to run a ChatGPT/Grok deep-research session, fill a research intake, trace how a story spread on X, or run a named research exercise. Drives an already-paid subscription seat instead of spending API tokens.
---

# deep-research

Drives **chatgpt.com** or **grok.com** through the real UI under a logged-in
browser and captures the report. Topic-agnostic: the prompt is the only
input. Every run lands in a `Deep research` project on the site so it never
clutters chat history.

Two ways to run it. Both produce the same intake file.

| | A. Runner script `run.mjs` | B. Claude in Chrome |
|---|---|---|
| Needs | Node, system Chrome, one cookie export per site | Claude Code with the extension, logged-in Chrome |
| Secrets | cookie file, seeded once, never read by an agent | none |
| Unattended | yes, blocks and saves | no, the agent polls the tab |

| Task | Read |
|---|---|
| First-time setup, cookies, `--check` | `recipes/setup-cookies.md` |
| ChatGPT specifics: effort ladder, Chat vs Work, project | `recipes/chatgpt.md` |
| Grok specifics: Expert vs Heavy, project, what X search sees | `recipes/grok.md` |
| Run interactively with no setup | `recipes/claude-in-chrome.md` |
| Runner internals: anti-detection, done rule, exit codes, probe | `recipes/runner-internals.md` |
| Research methods, each a prompt template with an output contract | `recipes/research/*.md` |
| Named exercises: author once, run on demand, tune over versions | below |

## Named exercises

A named exercise is a research recipe with the blanks filled for one
recurring question: "run the stocks analysis on SPCX". They live in
`~/.deep-research/exercises/<name>.md`, outside the repo, so they survive
skill updates and stay private. `scripts/exercise.mjs` manages them:

```bash
node scripts/exercise.mjs list
node scripts/exercise.mjs new spcx-stocks --from claim-check     # scaffold from a built-in recipe (or --blank)
node scripts/exercise.mjs show spcx-stocks
node scripts/exercise.mjs render spcx-stocks --set ticker=SPCX --set window="last 30 days"
      # → ~/.deep-research/exercises/spcx-stocks/runs/<ts>/intake.md, then run it:
node run.mjs --site grok --intake <that intake>          # or mode B
node scripts/exercise.mjs log spcx-stocks --run <ts> --verdict "good: timeline complete; weak: no press pickups"
```

Exercise file: frontmatter (`site`, `mode`, `slots`, `version`), a `## Brief`
with `{slot}` placeholders, an `## Output contract` the reply must follow, a
`## Verify` step, and a `## Changelog`. `render` fills the slots, appends the
contract and the sentinel line, and records which version produced the run.

**Tuning loop (agent):** after a run, judge the reply against the output
contract and the verify step. If it fell short, edit the exercise's brief,
bump `version`, add a changelog line saying what changed and why, and rerun.
Never edit a past run's intake; the runs directory is the history.

## Hard rules for an agent

1. Never open, print, copy, or summarise a cookie file; ask the user to
   export and place it (`recipes/setup-cookies.md`).
2. On ChatGPT, never send in **Work** mode; confirm **Chat** first.
3. A short reply ending in `?` is a clarifying question: surface it to the
   user, do not answer on their behalf.
4. The captured reply is **raw intake**. Every URL and timestamp is a lead
   until checked; the research recipes each say how.

## Intake file format

```markdown
# <title>

```
<the full research prompt>
```

## Output
```

The prompt is the first fenced block; the reply is appended under
`## Output`, tagged `[site · model]`, with a `### Links cited` list.
