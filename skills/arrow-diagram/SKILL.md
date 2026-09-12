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

The diagram goes to stdout. Exit 0 on success; exit 2 with a named reason on
stderr for any spec the renderer cannot draw (it never prints
`[object Object]` or a half-drawn shape). `GALLERY.md` holds worked examples
of every shape, and `render.test.mjs` replays them as golden tests.

## Spec

```json
{
  "dir": "lr",                    // "lr" (default) | "tb" | "tree"
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

## Choosing a direction

| `dir` | Use when | Supports |
|---|---|---|
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

An `lr` render wider than 110 columns prints a hint on stderr suggesting `tree`.

## Labels

Any text. Width is measured in terminal columns, so CJK, fullwidth, and
emoji labels (two columns each) keep rails and arcs aligned; `✓`, `→`, and
the diagonal arrows stay one column, matching what terminals draw.

## Errors the renderer refuses (exit 2)

- unknown `dir`; empty `flow`; a flow item that is not a string or group
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
