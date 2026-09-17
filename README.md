# skills

Agent skills for driving paid AI subscriptions as external agents, without
API keys, plus a renderer for aligned ASCII arrow diagrams. One repo, installable as a plugin in Claude Code, Codex, and
Antigravity, or dropped in by hand anywhere that reads `SKILL.md`.

| Skill | What it does |
|---|---|
| [`harness-coding-agents`](skills/harness-coding-agents/SKILL.md) | Run the Codex, Grok, Antigravity, and Claude Code CLIs as bounded read-only consultants or explicitly authorised implementers. Preflights binaries and logins, captures per-engine reports. |
| [`colab-harness`](skills/colab-harness/SKILL.md) | Use a Colab GPU runtime as a job server from your machine through a cloudflared tunnel: transcription and diarization, YouTube audio, a vLLM OpenAI endpoint, LoRA training pushed to private Hugging Face repos with a training report, DSPy compiles, a catalog of trained models, and jobs that survive a lost runtime. The agent starts the runtime itself (headless Playwright or Claude in Chrome); after setup you only say what to run. |
| [`arrow-diagram`](skills/arrow-diagram/SKILL.md) | Render aligned ASCII arrow diagrams (fan-out, fan-in, decision trees, retry loops, nesting) from a small JSON spec. Width-aware for CJK and emoji labels; refuses shapes it cannot draw instead of half-drawing them. |
| [`deep-research`](skills/deep-research/SKILL.md) | Run a deep-research prompt through a logged-in ChatGPT Pro or SuperGrok session in a real Chrome, wait for the report, and capture it into an intake file. Runs inside a dedicated project so it never clutters chat history. |

## Install

### Claude Code

```
/plugin marketplace add apresmoi/skills
/plugin install skills@apresmoi
```

### Codex CLI

```bash
codex plugin marketplace add apresmoi/skills
codex plugin add skills@apresmoi
```

Or install a single skill straight into `~/.codex/skills/` with the bundled
skill-installer, from inside Codex:

```
install the skill from https://github.com/apresmoi/skills/tree/main/skills/deep-research
```

### Antigravity

```bash
agy plugin install https://github.com/apresmoi/skills
```

### Manual (any harness that reads SKILL.md)

```bash
git clone git@github.com:apresmoi/skills.git ~/Documents/skills
ln -s ~/Documents/skills/skills/harness-coding-agents ~/.claude/skills/harness-coding-agents
ln -s ~/Documents/skills/skills/deep-research         ~/.claude/skills/deep-research
ln -s ~/Documents/skills/skills/arrow-diagram         ~/.claude/skills/arrow-diagram
ln -s ~/Documents/skills/skills/colab-harness         ~/.claude/skills/colab-harness
```

Swap `~/.claude/skills` for `~/.codex/skills` (Codex) or `~/.agents/skills`
(shared across harnesses that read that path).

## Requirements

- **harness-coding-agents**: Node 18+, and whichever of `codex`, `grok`, `agy`, `claude`
  you want on `PATH`, each logged in with its own subscription. Run
  `node scripts/consult.mjs --check --engine all` inside the skill folder to
  see what is ready. Claude Code requires v2.1.269+ and a saved subscription
  sign-in via `claude auth login`.
- **arrow-diagram**: Node 18+, nothing else.
- **colab-harness**: Node 18+ locally, a Colab Pro account with a GPU runtime, and for unattended starts an existing Playwright install anywhere on the machine (pointed at through `~/.colab-harness/config.json`); nothing is downloaded by the skill.
- **deep-research**: Node 18+, system Google Chrome, `npm install` inside the
  skill folder, and a one-time cookie export from a browser logged in to
  chatgpt.com and/or grok.com. Onboarding steps, including the rules for an
  agent handling the cookie file, are in the skill.

## Secrets

Nothing in this repo holds credentials. Logins stay in each CLI's own home
(`~/.codex`, `~/.grok`, Antigravity's OAuth store, Claude's native credential store) or, for deep-research,
under `~/.deep-research/` outside the repo. Never commit cookie files.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json   (Claude Code)
.codex-plugin/    plugin.json                      (Codex)
.agents/plugins/  marketplace.json                 (Codex marketplace)
skills/           one folder per skill, each with SKILL.md
```

## License

MIT. See [LICENSE](LICENSE).
