# Mode B: interactive via Claude in Chrome (no setup)

The agent uses its `mcp__claude-in-chrome__*` tools against the user's real,
logged-in Chrome, so no cookies, profiles, or anti-detection are involved.

1. Read the intake file; the prompt is its first fenced block. For one of the
   user's recipes, `render` it first (see SKILL.md) and use the produced intake.
2. Open a new tab at `https://chatgpt.com/` or `https://grok.com/`. Find the
   `Deep research` project in the sidebar; if absent, create it (ChatGPT:
   sidebar "New project", name, Create project. Grok: sidebar "Add project",
   name, Enter). Start the chat inside that project (Grok: hover the
   project row, click its "New chat"). Record the URL in
   `~/.deep-research/projects.json` under `<site>.<name>`; it is not a
   secret. Never assume a hardcoded project.
3. ChatGPT: confirm the **Chat / Work** toggle is on Chat; never send in
   Work. Enable **Deep research** in the composer tools and check the effort
   pill (default `Extra High`). Grok: pick **Expert** (or Heavy) and confirm
   it is shown.
4. Paste the prompt, send, tell the user the expected wait (15 to 60 min).
5. Poll the tab every few minutes with `get_page_text` or `find`. Done rule:
   not streaming, last assistant message at least 2500 characters, unchanged
   across two polls a few minutes apart. A short reply ending in `?` is a
   clarifying question: surface it to the user.
6. Copy the final message and its cited links under the intake's
   `## Output`, tagged `[site · model]`, exactly as the runner does. For a
   user recipe, add the `log` line with a verdict.
7. Leave the tab open so the user can read the original.

The reply is raw intake; apply the recipe's verify step before trusting it.
