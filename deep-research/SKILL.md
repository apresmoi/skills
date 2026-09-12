---
name: deep-research
description: Run any deep-research prompt through a logged-in ChatGPT Pro or Grok (SuperGrok) session in a real headed Chrome on the machine that holds the browser logins, wait for the report (15–60 min), and capture the reply into an intake file. Topic-agnostic — pass any prompt. Use when the user asks to run a ChatGPT/Grok deep-research session or fill a research intake. Drives an already-paid subscription seat instead of spending API or agent tokens.
---

# Deep-research runner (ChatGPT + Grok)

Drives **chatgpt.com** or **grok.com** through the real UI under a logged-in
browser. Runs on whichever machine holds the site logins and a display.
Always **headed**: the operator can intervene (answer clarifying questions,
fix tool/model selection). The script watches the conversation until a long,
stable assistant message appears, then saves it.

This skill is deliberately **topic-agnostic** — it runs whatever prompt you
give it. Nothing in it is scoped to a subject; the prompt is the only input.

Every run lands inside a **Project** on the site (ChatGPT and Grok both have
them), so research never clutters the personal chat history. The project is
found or created by name on first use (default name `Deep research`) and its
URL is remembered in `~/.deep-research/projects.json`. No project URL is
hardcoded anywhere.

Pick the site per need:
- **ChatGPT** (`--site chatgpt`, default) — general deep research.
- **Grok** (`--site grok`) — anything that benefits from reading X directly.

## Two ways to run it

| | A. Runner script (`run.mjs`) | B. Claude in Chrome (no setup) |
|---|---|---|
| Needs | Node, system Chrome, a one-time cookie export per site | Claude Code with the Claude in Chrome extension, logged-in Chrome |
| Secrets | cookie file, seeded once | none, it drives your own browser |
| Unattended / remote / cron | yes | no, needs a live session and your browser |
| Long waits | script blocks and saves the file | agent polls the tab |

Use **B** when you have Claude Code and a browser in front of you and just
want a report. Use **A** for unattended or remote runs, or without Claude Code.

## B. Interactive mode via Claude in Chrome

No onboarding. The agent uses its `mcp__claude-in-chrome__*` tools against
the user's real, logged-in Chrome, so no cookies, profiles, or anti-detection
are involved. Procedure for the agent:

1. Read the intake file; the prompt is its first fenced block.
2. Open a new tab at `https://chatgpt.com/` (or `https://grok.com/`). Find
   the `Deep research` project in the sidebar; if it does not exist, create
   it (ChatGPT: sidebar "New project" button, name, Create project. Grok:
   sidebar "Add project" button, name, Enter). Start the chat inside that
   project (Grok: hover the project row, click its "New chat"). Record the
   project URL in `~/.deep-research/projects.json` under `<site>.<name>` so
   the runner and later sessions reuse it; it is not a secret. Never assume
   a hardcoded project.
3. ChatGPT: enable **Deep research** in the composer tools and confirm the
   effort pill (default `Extra High`). Grok: pick **Expert** (or `Heavy`) in
   the model menu and confirm the selection is visible before sending.
4. Paste the prompt, send, and tell the user the expected wait (15 to 60 min).
5. Poll the tab every few minutes with `get_page_text` or `find`. Apply the
   same done rule as the runner: not streaming, last assistant message at
   least 2500 characters, unchanged across two polls a few minutes apart.
   A short reply ending in `?` is a clarifying question: surface it to the
   user, do not answer on their behalf.
6. Copy the final message and its cited links under the intake's `## Output`
   marker, tagged `[site · model]`, exactly as mode A does.
7. Leave the tab open so the user can read the original.

The provenance rule below applies equally: the reply is raw intake.

## A. Runner script: first-time setup (onboarding)

The runner never logs in by itself. It needs a **cookie export from a browser
where you are already logged in** to each site you want to use. Do this once
per site; afterwards the persistent Chrome profile holds the session.

### 1. Install the runner

```bash
cd <this skill folder>
npm install                       # installs playwright
# system Chrome must be installed: the runner uses channel "chrome", not
# Playwright's bundled Chromium (bundled Chromium gets a degraded UI).
```

### 2. Export cookies from your logged-in browser

In the browser where you are logged in to chatgpt.com (and/or grok.com),
install any extension that exports cookies in **Netscape `cookies.txt`**
format, for example:

- Get cookies.txt CLEAN — https://chromewebstore.google.com/detail/get-cookiestxt-clean/ahmnmhfbokciafffnknlekllgcnafnie
- Get cookies.txt LOCALLY — https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc

Open the site, click the extension, export **for the current site only**.
You get one file per site. Any other tool that produces Netscape-format
cookies works the same.

### 3. Place the cookie files

State lives under `$DEEP_RESEARCH_HOME` (default `~/.deep-research/`), never
inside this folder or any repo. Expected paths:

```
~/.deep-research/
├── secrets/
│   ├── chatgpt.com_cookies.txt      (dir 700, files 600)
│   └── grok.com_cookies.txt
├── profiles/
│   ├── chatgpt/                     (created on first run)
│   └── grok/
└── projects.json                    (remembered project URLs, not secret)
```

```bash
mkdir -p ~/.deep-research/secrets && chmod 700 ~/.deep-research/secrets
mv ~/Downloads/chatgpt.com_cookies.txt ~/.deep-research/secrets/
mv ~/Downloads/grok.com_cookies.txt    ~/.deep-research/secrets/
chmod 600 ~/.deep-research/secrets/*_cookies.txt
```

Or pass `--cookies <path>` to point at a file elsewhere.

### 4. Verify

```bash
node run.mjs --check                  # chatgpt
node run.mjs --site grok --check
```

`--check` also completes onboarding: it finds or creates the `Deep research`
project on that site and stores its URL in `~/.deep-research/projects.json`.
You should see a line like `Project "Deep research" → <url> (created)`.

Exit 0 = logged in, UI not degraded, project ready. Exit 2 = login degraded
or expired, or the project could not be opened or created: delete that
site's `profiles/<site>/` dir and re-export cookies.

### Rules for an agent doing the onboarding

If an AI agent is wiring this up for a user:

- **Never open, print, cat, grep, or summarise the cookie file.** It is a
  session credential. The only permitted operations are: move or copy it to
  the secrets path, set permissions, and check that it exists and is
  non-empty (`ls -l`, `wc -c`).
- Never paste its contents into a prompt, a chat, a log, a commit, or a
  report. Never commit it. Keep `.deep-research/` out of every repo.
- Tell the user which file to export and where to drop it, then verify with
  `--check` only. If `--check` fails, ask the user to re-export; do not
  inspect the file to diagnose.
- Cookies only **seed the profile on first run**. After that the profile
  directory holds the live session and the cookie file can be deleted.

## A. Runner script: usage

```bash
cd <this skill folder>

# verify a site's login still works (fast, sends nothing)
node run.mjs --check
node run.mjs --site grok --check

# run an intake file: reads the first ```fenced``` block as the prompt,
# appends the reply + cited links below the "## Output" marker
node run.mjs --intake ./research/topic.md
node run.mjs --site grok --intake ./research/topic.md

# ad-hoc prompt
node run.mjs --prompt "..." --out ./reply.md
```

Options: `--site chatgpt|grok`, `--model "<label>"`, `--no-send` (fill the
prompt, operator presses send), `--timeout-min 90`, `--cookies <path>`,
`--profile <name>` (a separate Chrome profile on the same site, seeded from
the same cookie file, so several sessions can run in parallel).

Project options: `--project <name>` uses or creates a differently named
project (default `Deep research`, or `DEEP_RESEARCH_PROJECT_NAME`);
`--no-project` runs in the root chat instead; `--url <start url>` (or
`DEEP_RESEARCH_PROJECT_URL` / `DEEP_RESEARCH_GROK_PROJECT_URL`) starts at an
explicit URL and skips project resolution. Remembered URLs live in
`~/.deep-research/projects.json`; delete an entry to force re-resolution.

Grok: the project composer keeps the model menu (Auto / Fast / Expert /
Build / Heavy), and the runner still verifies the requested Expert/Heavy
selection before sending; a visible composer alone is not enough.

## Intake file format

A markdown file with the prompt in the first fenced block and an `## Output`
marker where the reply is appended:

````markdown
# <title>

```
<the full research prompt>
```

## Output
````

## Model / effort

Set automatically per site; override with `--model`.
- **ChatGPT** composer pill. With Deep research ON, the ladder is `Instant` ·
  `Medium` · `High` · **`Extra High`** (default — the top deep-research tier).
- **Grok** model menu: `Auto` · `Fast` · **`Expert`** (default) · `Heavy`
  (slower multi-agent). Grok has no separate DeepSearch toggle — Expert/Heavy
  *is* the research depth.

## Anti-detection (why it's a persistent Chrome profile)

Both sites serve a **degraded UI** — no chat history, no model picker, deep
research hidden — when they detect automation via `navigator.webdriver`.
The fix:

- launch a **persistent Chrome profile** (`channel: 'chrome'`, real Chrome,
  not bundled Chromium) under the state dir's `profiles/<site>/`,
- `ignoreDefaultArgs: ['--enable-automation']` +
  `--disable-blink-features=AutomationControlled` → `navigator.webdriver`
  reads `false`.

The startup line prints `navigator.webdriver`, the model pill, and history
count — if `webdriver` is true or history is 0, the UI came up degraded.

## Selector debugging

`probe.mjs` opens the ChatGPT profile against a URL and dumps composer
selectors, test ids, and the deep-research toggle state. Use it when the site
UI changes and `run.mjs` can no longer find the composer:

```bash
node probe.mjs https://chatgpt.com/
```

## Behavior notes

- Run from a real terminal with a display, not a sandboxed or backgrounded
  shell — the headed window needs a display and the manual "press Enter"
  fallback needs stdin. Close any other Chrome using the same profile first
  (persistent profiles are single-instance).
- A short assistant reply ending in `?` is treated as a **clarifying
  question**: the script warns and keeps waiting — answer it in the window.
- Done-detection: not streaming + message ≥ 2500 chars + unchanged 2.5 min
  (or any stable reply after 10 min). On timeout the browser stays open.
- Output: text appended to the intake (or `--out`), tagged `[site · model]`,
  plus a `### Links cited` list and a `.<site>.reply.html` with the original
  citation anchors.
- Exit codes: 2 = login degraded/expired, 3 = timeout.

## Provenance rule

The captured reply is **raw intake**. Source URLs must still be checked before
anything from it is trusted as fact — a deep-research report is a lead
generator, not an oracle.
