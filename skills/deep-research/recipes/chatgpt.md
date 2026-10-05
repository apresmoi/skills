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
- **Deep research** is a composer tool (the + menu, "Add files and more").
  The runner enables it, confirms the composer shows the Deep research chip,
  and refuses to send unless the model picker reads **6 Pro** or **5.6 Pro**
  (default `--model Pro`). The old `Instant · … · Extra High` effort ladder is
  gone; effort is now a slider inside the model menu.
- Good at: broad web synthesis, long structured reports, citing press and
  papers. Weak at: anything that lives mainly on X; use Grok for that.
- Typical wait: 5 to 40 minutes. Sessions usually show a research plan
  first; the runner accepts it. A clarifying question is auto-answered.
