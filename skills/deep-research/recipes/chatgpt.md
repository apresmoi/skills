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
- **Deep research** is a composer tool (the + menu). With it on, the effort
  pill ladder is `Instant · Medium · High · Extra High`; the runner picks
  `Extra High`, the top research tier. `--model "<label>"` overrides.
- Good at: broad web synthesis, long structured reports, citing press and
  papers. Weak at: anything that lives mainly on X; use Grok for that.
- Typical wait: 15 to 40 minutes at Extra High. Sessions can ask a
  clarifying question first; the runner waits for you to answer it in the
  window.
