---
name: deep-research
description: Run any deep-research prompt through a logged-in ChatGPT Pro or Grok (SuperGrok) session in a real Chrome, wait for the report (15–60 min), and capture it into an intake file — plus research recipes (spread timelines on X, claim checks, origin attribution) and your own named recipes that render a tuned prompt on demand. Use when the user asks to run a ChatGPT/Grok deep-research session, fill a research intake, trace how a story spread on X, or run one of the user's named research recipes. Drives an already-paid subscription seat instead of spending API tokens.
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
| Built-in research recipes: prompt template, output contract, verify step | `recipes/research/*.md` |
| Your own recipes: author once, run on demand, tune over versions | below |

## Your own recipes

A built-in recipe is a method. Your own recipe is that method with the
blanks filled for one recurring question: "run the SPCX recipe". They live
in `~/.deep-research/recipes/<name>.md`, outside the repo, so they survive
skill updates and stay private. `scripts/recipe.mjs` manages them:

```bash
node scripts/recipe.mjs builtin                                   # what to start from
node scripts/recipe.mjs new spcx-stocks --from claim-check        # scaffold, then edit the brief
node scripts/recipe.mjs convert spcx-stocks --intake research/spcx.md --slot ticker=SPCX --slot window="Q3 2026"
      # or: turn a research run that worked into a recipe; literals become {slots}, the run is kept as v1's evidence
node scripts/recipe.mjs render spcx-stocks --set ticker=SPCX --set window="Q4 2026"
      # → ~/.deep-research/recipes/spcx-stocks/runs/<ts>/intake.md, then run it:
node run.mjs --site chatgpt --model "Extra High" --intake <that intake>   # or mode B
node scripts/recipe.mjs log spcx-stocks --run <ts> --verdict "good: ...; weak: ..."
node scripts/recipe.mjs list · show · runs
```

Recipe file: frontmatter (`site`, `mode`, `slots`, `version`), a `## Brief`
with `{slot}` placeholders, an `## Output contract` the reply must follow, a
`## Verify` step, and a `## Changelog`. `render` fills the slots, appends the
contract and the sentinel line, and records which version produced the run.

**Authoring one with the user (agent):** ask three things: what question it
answers, which parts change run to run (those are the slots), and what shape
the answer must come back in (the contract). Start from the nearest built-in.

**Tuning loop (agent):** after a run, judge the reply against the output
contract and the verify step. If it fell short, edit the brief, bump
`version`, add a changelog line saying what changed and why, and rerun.
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
