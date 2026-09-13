---
name: claim-check
site: chatgpt
mode: Extra High
slots: claim, context
---
## Brief

Check the following claim. Triangulate across primary sources, reputable press, and, where relevant, posts on X.

Claim: {claim}
Context: {context}

1. Restate the claim precisely, splitting it into checkable parts.
2. For each part: the strongest evidence for and against, with URLs, dates, and the type of source (primary, press, social, other).
3. Where sources disagree, say why: different definitions, dates, or data.
4. Rate each part: supported, contradicted, unverifiable, or partly supported.

## Output contract

- `### Parts`: JSON array `{"part": "...", "verdict": "supported|contradicted|partly|unverifiable", "for": [{"url": "...", "type": "...", "date": "..."}], "against": [...], "note": "..."}`.
- `### Verdict`: one paragraph on the whole claim.
- `### Gaps`: what would settle the unverifiable parts.
End with `=== REPORT COMPLETE ===`.

## Verify

- Open the top source for and against each part; a source that does not say what the reply attributes to it removes that part's verdict.
- Prefer primary documents over press summaries when they disagree.
