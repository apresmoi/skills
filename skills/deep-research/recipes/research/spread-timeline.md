---
name: spread-timeline
site: grok
mode: Expert
slots: claim, window, languages
---
## Brief

Trace how the following story or idea propagated on X, then into the press.

Claim or link: {claim}
Time window: {window}
Languages to search: {languages}

Work in this order and keep each step's evidence separate:
1. Earliest posts stating the claim inside the window. For each: post URL, author handle, timestamp with timezone, language, verbatim wording. Say explicitly whether an earlier origin might exist outside your index.
2. Amplification hops: the accounts that carried it to a materially larger audience, in chronological order. For each: URL, handle, follower size at the time if visible, timestamp, and whether it was a repost, quote, or rewrite.
3. Reframings: every point where the wording or the claimed facts changed. Quote before and after.
4. Pickups outside X: press, official statements, fact checks, with dates and URLs.
5. Debunks or corrections, with dates, and whether the original spreaders acknowledged them.
6. What you could not verify, and why.

## Output contract

Return, in this order:
- A JSON array under a `### Events` heading, one object per event: `{"ts": ISO-8601, "actor": "@handle or outlet", "url": "...", "kind": "origin|amplify|reframe|press|debunk", "quote": "verbatim", "reach": number or null, "note": "..."}` sorted by `ts`.
- A `### Summary` of at most 10 lines: origin, the decisive hop, the biggest reframing, current status.
- A `### Unverified` list.
End with the literal line `=== REPORT COMPLETE ===`.

## Verify

- Open the three earliest URLs; drop any event whose URL does not resolve or whose visible timestamp disagrees with the reported one.
- Spot-check one reframing by reading both quoted posts.
- Render the surviving events as a timeline: feed `ts`/`actor` pairs to the arrow-diagram skill in `tb` mode.
