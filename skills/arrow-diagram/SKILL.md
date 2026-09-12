---
name: arrow-diagram
description: Render ASCII arrow/flow diagrams (fan-out, fan-in, decision trees, retry loops) from a small JSON spec — use whenever an answer needs an arrow-based flow or topology diagram instead of hand-aligning box characters. Triggers on "arrow diagram", "ascii diagram", "flow diagram", "draw the pipeline", "conversation flow".
---

# arrow-diagram — JSON in, aligned ASCII diagram out

Never hand-align `┌ ├ └ →` characters. Emit a small JSON spec and run
`render.mjs` from this skill's directory:

```bash
node render.mjs graph.json          # spec from a file
node render.mjs '{"flow":[…]}'      # inline JSON
echo '{"flow":[…]}' | node render.mjs
node render.mjs --help
```

## Know the width of the destination first

A diagram wider than the box it lands in soft-wraps and turns into garbage.
The renderer plans against a column budget: `--width N` on the CLI, else
`"width": N` in the spec, else **80**. Before rendering, decide the budget:

| Destination | Budget |
|---|---|
| Chat UI code block (Claude, ChatGPT, Slack, GitHub comment) | 80, the default |
| Terminal | `$COLUMNS`, or `tput cols` |
| Markdown file, README | 80 to 100 |

With no `dir`, the renderer picks the first mode that fits, in this order:
`lr`, a wrapped chain (plain chains without loops), `tree` (no loops), `tb`
(plain fans, no branch). An explicit `dir` is always honoured, but an
overflow prints a warning on stderr naming which modes would fit. When
nothing fits, it exits 2 listing why each mode failed: shorten labels, raise
the budget, or split the diagram.

A wrapped chain snakes onto the next row:

```
receive request ─→ validate schema ─→ authenticate caller ─┐
┌──────────────────────────────────────────────────────────┘
└─→ load tenant config ─→ apply rate limit ─→ send
```

The diagram goes to stdout. Exit 0 on success; exit 2 with a named reason on
stderr for any spec the renderer cannot draw (it never prints
`[object Object]` or a half-drawn shape). `GALLERY.md` holds worked examples
of every shape, and `render.test.mjs` replays them as golden tests.

## Spec

```json
{
  "dir": "auto",                  // "auto" (default) | "lr" | "tb" | "tree"
  "width": 80,                    // column budget; CLI --width overrides
  "flow": [ "task", "planner", { "parallel": […] }, { "branch": […] } ],
  "loops": [ { "from": "tests", "to": "planner", "label": "fail, retry" } ]
}
```

A `flow` item is a **plain node** (string), a **`parallel`** group, or a
**`branch`** group. Inside a group, each alternative is a string or an array
(a nested flow, which may itself contain groups, to any depth).

## The three primitives

**`parallel`** — fan-out that reconverges. Concurrent workers, judge panels.

```
                  ┌─→ coding agent ─→ tests ─┐
task ─→ planner ──┤                          ├─→ reviewer ─→ merge
                  └─→ research agent ────────┘
```

Alternatives can hold their own groups; the outer rails bend at each
alternative's own trunk row:

```
    ┌─→ x ────────────┐
    │       ┌─→ p ─┐  │
a ──┼─→ y ──┼─→ q ─┼──┼─→ b
    │       └─→ r ─┘  │
    └─→ z ────────────┘
```

**`branch`** — fan-out that does *not* reconverge: decision trees, early
exits, escalation ladders. Must be the last item of its flow; nests recursively.

```
cancel request ─→ objection 1 ──┬─→ keeps promo ✓
                                └─→ insists ─→ objection 2 ──┬─→ takes offer ✓
                                                             └─→ insists ─→ cancel granted
```

**`loops`** — back-edges below the trunk (LR) or a return channel down the
right margin (TB). `from` and `to` name **whole node labels**, matched
exactly against the nodes placed during layout, so `agent` never lands
inside `coding agent` and labels may contain spaces. A label used as an
endpoint must be unique in the flow. Channels route through intervening
rows, so loops stack without colliding:

```
prompt ─→ agent ─→ tests ─→ review ─→ merge
   ↑        ↑        │         │
   │        └────────┘         │
   │       fail, retry         │
   │                           │
   └── design flaw, rethink ───┘
```

A loop whose `from` precedes its `to` (a skip-ahead) draws the same way,
with the arrowhead under the destination.

Loops are stacked in spec order, each arc one band lower. Nested loops (one
span inside another) never touch. Interleaved loops (spans that overlap
without nesting) must cross, because the later loop's channel runs down
through the earlier arc; the crossing is drawn as `╫` (a vertical passing
over a horizontal, no connection) and labels are placed clear of it. `┼` is
reserved for fan junctions, where lines do join. Two loops sharing an
endpoint share the channel: the earlier arc's corner becomes `├` or `┤`. A label too long for its span hangs to the right of the arc,
or drops below when another channel is in the way.

## Choosing a direction

| `dir` | Use when | Supports |
|---|---|---|
| `auto` | you don't care, as long as it fits the width budget | picks from the rows below |
| `lr` | sequence and order: what happens after what | parallel, branch, loops, nesting |
| `tb` | funnels: which candidate wins, volume narrowing to a verdict | parallel (max 3, plain labels), loops |
| `tree` | deep decision ladders that would run off the page in `lr` | parallel, branch, nesting |

`tree` keeps chains horizontal but costs only 4 columns per nesting level:

```
user: cancel ─→ objection 1: metrics
├─→ persuaded ✓
└─→ insists ─→ objection 2: pause instead
    ├─→ takes pause ✓
    └─→ insists ─→ objection 3: discount
        ├─→ takes discount ✓
        └─→ insists ─→ cancel granted ─→ exit survey
```


## Labels

Any single-line printable text; `dir` is case-insensitive and numeric loop
labels are accepted. Width is measured in terminal columns, so CJK, fullwidth, and
emoji labels (two columns each) keep rails and arcs aligned; `✓`, `→`, and
the diagonal arrows stay one column, matching what terminals draw.

## Errors the renderer refuses (exit 2)

- an unknown top-level or loop key (typos like `loop` or `lable` are caught)
- unknown `dir`; a `width` under 20; empty `flow`; a flow item that is not a string or exactly one group
- an empty label, or one containing a tab, newline, or other control character
- `parallel` with no alternatives; `branch` with fewer than two; an empty nested flow
- in `tb`, a loop endpoint that is not the rightmost label of its fan
- no mode fits the width budget (auto mode only)
- `branch` not last in its flow; `branch` in `tb` mode
- nested groups or chain alternatives in `tb` mode (use `lr`)
- `loops` in `tree` mode; a self-loop; an endpoint that is not a node
  label, or that matches more than one node

## Limits

This renders **series-parallel trees with decorative back-edges**, not
arbitrary digraphs. There is no layout engine: nodes are placed in spec order,
edges are not routed around each other, and there are no edge weights or
multi-parent nodes. A loop endpoint inside a fan gets its arrowhead under the
node, but the channel may show a gap where it crosses another alternative's
text. For mined/observed graphs (arbitrary cycles, traffic percentages), emit
mermaid or graphviz instead and let a real engine lay it out.
