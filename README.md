# skills

Claude Code skills for driving paid AI subscriptions as external agents,
without API keys.

| Skill | What it does |
|---|---|
| [`harness-coding-agents`](harness-coding-agents/SKILL.md) | Run the Codex, Grok, and Antigravity CLIs as bounded read-only consultants or explicitly authorised implementers. Preflights binaries and logins, captures per-engine reports. |
| [`deep-research`](deep-research/SKILL.md) | Run a deep-research prompt through a logged-in ChatGPT Pro or SuperGrok session in a real Chrome, wait for the report, and capture it into an intake file. Runs inside a dedicated project so it never clutters chat history. |

## Install

Each folder is one skill. Copy or symlink it into your Claude Code skills
directory:

```bash
git clone git@github.com:apresmoi/skills.git ~/Documents/skills
ln -s ~/Documents/skills/harness-coding-agents ~/.claude/skills/harness-coding-agents
ln -s ~/Documents/skills/deep-research         ~/.claude/skills/deep-research
```

Claude Code picks up skills in `~/.claude/skills/<name>/SKILL.md` on the next
session. Each `SKILL.md` carries its own setup and usage.

## Requirements

- **harness-coding-agents**: Node 18+, and whichever of `codex`, `grok`, `agy`
  you want on `PATH`, each logged in with its own subscription. Run
  `node scripts/consult.mjs --check --engine all` to see what is ready.
- **deep-research**: Node 18+, system Google Chrome, `npm install` inside the
  skill folder, and a one-time cookie export from a browser logged in to
  chatgpt.com and/or grok.com. Onboarding steps, including the rules for an
  agent handling the cookie file, are in the skill.

## Secrets

Nothing in this repo holds credentials. Logins stay in each CLI's own home
(`~/.codex`, `~/.grok`, Antigravity's OAuth store) or, for deep-research,
under `~/.deep-research/` outside the repo. Never commit cookie files.
