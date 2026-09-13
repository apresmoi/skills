---
name: account-profile
site: grok
mode: Expert
slots: handle, topic, window
---
## Brief

Summarise what the account {handle} has said on X about {topic} during {window}.

1. Chronological list of the account's own posts on the topic: URL, timestamp, verbatim text or a faithful excerpt, and whether it was a post, reply, or quote.
2. Position changes: where a later post contradicts or softens an earlier one, quote both.
3. Interlocutors: accounts it argued with or amplified on this topic, with one URL each.
4. Engagement pattern: which posts drew the most reach, as far as visible.

## Output contract

- `### Posts`: JSON array `{"ts": ISO-8601, "url": "...", "kind": "post|reply|quote", "quote": "..."}`.
- `### Position changes`: JSON array `{"earlier": {"url": "...", "quote": "..."}, "later": {"url": "...", "quote": "..."}}`.
- `### Summary`: at most 8 lines.
End with `=== REPORT COMPLETE ===`.

## Verify

- Open five posts spread across the window; confirm author, date, and text.
- Public posts only; if the account is private or blocks search, say so and stop.
