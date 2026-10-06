# ChatGPT specifics

- Start at `https://chatgpt.com/` or the remembered `Deep research`
  project; `--project <name>` uses another, `--no-project` the root chat,
  `--url` an explicit page. Remembered URLs are in
  `~/.deep-research/projects.json`; delete an entry to force re-resolution.
- **Chat vs Work.** A toggle above the composer routes the prompt either to
  a chat or to an agentic task run (Work), which is metered differently
  and is not a research session. The runner forces Chat and refuses to run
  (exit 1, "not in Chat mode") if it cannot confirm it. In mode B, confirm
  Chat by eye before sending; if it cannot be selected, stop and tell the
  user.
- **Deep research** is a composer tool (the + menu; the row reads "Deep research ·
  Get a detailed report", plain divs, and the project page's H1 also says "Deep
  research", so the runner matches the subtitle). With it on, the pill becomes a
  5-step "Thinking effort" slider (Instant … 6 Pro), moved with ArrowRight on the
  hovered slider row (End does nothing). The runner pushes it to the top and verifies
  the header reads "6 Pro" / pill "Pro" (as of 2026-10-05). `--model "<label>"` overrides;
  `--model Instant` picks the fastest step, for smoke tests that only need a reply.
- **Regular chat (`--compose`)** is read from the conversation API like deep research, polled every
  15 s (4 s drew HTTP 429). GPT-6 Pro still thinks 8-20 min in regular chat, so the default
  timeout is 45 min; use `--model Instant` when speed matters.
- Good at: broad web synthesis, long structured reports, citing press and
  papers. Weak at: anything that lives mainly on X; use Grok for that.
- Typical wait: 5 to 40 minutes. Sessions usually show a research plan
  first; the runner accepts it. A clarifying question is auto-answered.
