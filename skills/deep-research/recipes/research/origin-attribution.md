---
name: origin-attribution
site: grok
mode: Expert
slots: claim, window
---
## Brief

Establish who first stated the following on X, and who is responsible for its reach.

Claim: {claim}
Window: {window}

1. Candidate origins: the earliest posts you can find with this claim or a clear precursor. For each, URL, handle, timestamp with timezone, verbatim text. Rank them by timestamp and say how confident you are that nothing earlier exists.
2. Precursors: earlier posts or articles with the same idea in different words, if any.
3. Attribution chain: for the top three amplifiers, whether they credited a source, and whom.
4. Misattributions: cases where the claim was credited to the wrong account or outlet.

## Output contract

- `### Candidates`: JSON array `{"rank": n, "ts": ISO-8601, "actor": "@handle", "url": "...", "quote": "...", "confidence": "high|medium|low", "why": "..."}`.
- `### Attribution chain`: JSON array `{"actor": "@handle", "credited": "@handle or null", "url": "..."}`.
- `### Misattributions`: bullet list with URLs.
- `### Verdict`: three lines, the most likely origin and the confidence.
End with `=== REPORT COMPLETE ===`.

## Verify

- Open every candidate URL; confirm the timestamp on the post itself.
- Search X manually for the exact quote of the top candidate with a `since:` one day earlier to look for something older.
