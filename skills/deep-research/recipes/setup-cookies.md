# Setup: runner script and cookies (one time per site)

The runner never logs in by itself. It needs a cookie export from a browser
where you are already logged in to each site. After the first run the
persistent Chrome profile holds the session and the cookie file can go.

## 1. Install

```bash
cd <this skill>
npm install                  # playwright
```

System Google Chrome must be installed: the runner uses `channel: 'chrome'`,
not Playwright's bundled Chromium, which gets a degraded UI.

## 2. Export cookies (user)

In the browser logged in to chatgpt.com and/or grok.com, install a Netscape
`cookies.txt` exporter, for example:

- Get cookies.txt CLEAN — https://chromewebstore.google.com/detail/get-cookiestxt-clean/ahmnmhfbokciafffnknlekllgcnafnie
- Get cookies.txt LOCALLY — https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc

Open the site, export **for the current site only**. One file per site.

## 3. Place them (user, or agent by move only)

```
~/.deep-research/
├── secrets/                          dir 700, files 600
│   ├── chatgpt.com_cookies.txt
│   └── grok.com_cookies.txt
├── profiles/{chatgpt,grok}/          created on first run
├── projects.json                     remembered project URLs, not secret
└── recipes/<name>.md + runs/         your recipes and their run history
```

```bash
mkdir -p ~/.deep-research/secrets && chmod 700 ~/.deep-research/secrets
mv ~/Downloads/chatgpt.com_cookies.txt ~/.deep-research/secrets/
mv ~/Downloads/grok.com_cookies.txt    ~/.deep-research/secrets/
chmod 600 ~/.deep-research/secrets/*_cookies.txt
```

Or pass `--cookies <path>`.

## 4. Verify

```bash
node run.mjs --check                  # chatgpt
node run.mjs --site grok --check
```

`--check` also finds or creates the `Deep research` project and stores its
URL. Exit 0 = logged in, UI not degraded, project ready. Exit 2 = login
degraded or expired: delete `profiles/<site>/` and re-export.

## Agent rules

- The only permitted operations on a cookie file are move, chmod, and an
  existence or size check. Never open, print, grep, or summarise it; never
  paste it anywhere; never commit `~/.deep-research/`.
- If `--check` fails, ask the user to re-export; do not inspect the file to
  diagnose.
