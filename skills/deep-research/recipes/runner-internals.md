# Runner internals

## Usage

```bash
node run.mjs --check                          # login + project, sends nothing
node run.mjs --intake ./research/topic.md     # prompt = first fenced block, reply appended under ## Output
node run.mjs --site grok --intake ./research/topic.md
node run.mjs --prompt "..." --out ./reply.md
```

Options: `--site chatgpt|grok`, `--model "<label>"`, `--no-send` (fill the
prompt, the operator presses send), `--timeout-min 90`, `--cookies <path>`,
`--profile <name>` (a second Chrome profile on the same site, so sessions
can run in parallel), `--project <name>`, `--no-project`, `--url <start url>`.

## Anti-detection

Both sites serve a degraded UI (no history, no model picker, deep research
hidden) when `navigator.webdriver` is true. The runner launches a
persistent real-Chrome profile under `profiles/<site>/` with
`ignoreDefaultArgs: ['--enable-automation']` and
`--disable-blink-features=AutomationControlled`. The startup line prints
`navigator.webdriver`, the model pill, and the history count; webdriver true
or history 0 means the UI came up degraded.

## Behaviour

- Needs a real terminal with a display, not a backgrounded shell; the
  manual "press Enter" fallback needs stdin. Close any other Chrome using
  the same profile first.
- Done-detection: not streaming, message at least 2500 chars, unchanged for
  2.5 min (or any stable reply after 10 min). On timeout the browser stays
  open.
- Output: text appended to the intake (or `--out`), tagged `[site · model]`,
  plus `### Links cited` and a `.<site>.reply.html` with the original
  citation anchors.
- Exit codes: 1 = refused (e.g. ChatGPT not in Chat mode), 2 = login
  degraded or expired, 3 = timeout.

## Selector debugging

`probe.mjs <url>` opens the ChatGPT profile and dumps composer selectors,
test ids, and the deep-research toggle state. Use it when a site changes its
UI and `run.mjs` can no longer find the composer.
