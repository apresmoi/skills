# Research recipes

Each recipe is a prompt template with `{slots}`, a fixed **output contract**
so runs are comparable, and a **verify** step, because a deep-research reply
is a lead generator, not a source. Use them directly, or turn one into a
named exercise with `node scripts/exercise.mjs new <name> --from <recipe>`.

| Recipe | Question | Best site |
|---|---|---|
| `spread-timeline` | how did this story or idea propagate on X, hop by hop | grok, Heavy for wide spreads |
| `origin-attribution` | who said it first, who amplified, who reframed | grok |
| `narrative-drift` | how the framing changed from origin to now | grok |
| `claim-check` | is this specific claim true, triangulated across sources | chatgpt, or grok for X-native claims |
| `account-profile` | what has this account said about a topic over time | grok |

Frontmatter fields: `site`, `mode`, `slots`. The exercise CLI reads them.
