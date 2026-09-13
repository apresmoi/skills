---
name: narrative-drift
site: grok
mode: Expert
slots: topic, window
---
## Brief

Show how the dominant framing of the following topic changed on X over the window.

Topic: {topic}
Window: {window}

1. Split the window into 4 to 6 phases where the framing was stable.
2. For each phase: the dominant framing in one sentence, two representative posts with URLs and timestamps, the accounts driving it, and what event or post caused the shift into the next phase.
3. Terms and labels that appeared or disappeared, with the first post using each.
4. Competing framings that existed at the same time and which one won, if any.

## Output contract

- `### Phases`: JSON array `{"from": ISO-8601, "to": ISO-8601, "framing": "...", "drivers": ["@handle"], "examples": [{"url": "...", "quote": "..."}], "trigger": "..."}`.
- `### Vocabulary`: JSON array `{"term": "...", "first_seen": ISO-8601, "url": "..."}`.
- `### Summary`: at most 8 lines.
End with `=== REPORT COMPLETE ===`.

## Verify

- Open one example per phase; confirm the quote and date.
- Check that each trigger is a real post or event with a URL, not an inference.
