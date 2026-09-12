# arrow-diagram — stress gallery

The first three entries pin `"dir": "lr"` on purpose: they are width stress
cases and would otherwise auto-switch to a narrower mode.

Every diagram below was produced by `render.mjs` from the JSON above it. No hand alignment.

## Deep nested branch tree (5 levels of refusal)

```json
{
  "dir": "lr",
  "flow": [
    "user: cancel",
    "objection 1: metrics",
    {
      "branch": [
        [
          "persuaded ✓"
        ],
        [
          "insists",
          "objection 2: pause instead",
          {
            "branch": [
              [
                "takes pause ✓"
              ],
              [
                "insists",
                "objection 3: discount",
                {
                  "branch": [
                    [
                      "takes discount ✓"
                    ],
                    [
                      "insists",
                      "objection 4: keep perks 30d",
                      {
                        "branch": [
                          [
                            "relents ✓"
                          ],
                          [
                            "insists",
                            "cancel granted",
                            "exit survey"
                          ]
                        ]
                      }
                    ]
                  ]
                }
              ]
            ]
          }
        ]
      ]
    }
  ]
}
```

```
user: cancel ─→ objection 1: metrics ──┬─→ persuaded ✓
                                       └─→ insists ─→ objection 2: pause instead ──┬─→ takes pause ✓
                                                                                   └─→ insists ─→ objection 3: discount ──┬─→ takes discount ✓
                                                                                                                          └─→ insists ─→ objection 4: keep perks 30d ──┬─→ relents ✓
                                                                                                                                                                       └─→ insists ─→ cancel granted ─→ exit survey
```

## Asymmetric branch: long chain vs dead end

```json
{
  "dir": "lr",
  "flow": [
    "webhook",
    "verify signature",
    {
      "branch": [
        [
          "invalid → 401"
        ],
        [
          "valid",
          "parse",
          "route",
          "handler",
          "enqueue",
          "ack 200"
        ]
      ]
    }
  ]
}
```

```
webhook ─→ verify signature ──┬─→ invalid → 401
                              └─→ valid ─→ parse ─→ route ─→ handler ─→ enqueue ─→ ack 200
```

## Parallel of chains, then branch

```json
{
  "dir": "lr",
  "flow": [
    "spec",
    {
      "parallel": [
        [
          "draft A",
          "review A"
        ],
        [
          "draft B",
          "review B"
        ],
        [
          "draft C",
          "review C"
        ]
      ]
    },
    "judge panel",
    {
      "branch": [
        [
          "winner → merge"
        ],
        [
          "tie",
          "re-run panel"
        ],
        [
          "all bad",
          "rewrite spec"
        ]
      ]
    }
  ]
}
```

```
       ┌─→ draft A ─→ review A ─┐
spec ──┼─→ draft B ─→ review B ─┼─→ judge panel ──┬─→ winner → merge
       └─→ draft C ─→ review C ─┘                 ├─→ tie ─→ re-run panel
                                                  └─→ all bad ─→ rewrite spec
```

## Two nested loops on one spine

```json
{
  "flow": [
    "prompt",
    "agent",
    "tests",
    "review",
    "merge"
  ],
  "loops": [
    {
      "from": "tests",
      "to": "agent",
      "label": "fail, retry"
    },
    {
      "from": "review",
      "to": "prompt",
      "label": "design flaw, rethink"
    }
  ]
}
```

```
prompt ─→ agent ─→ tests ─→ review ─→ merge
   ↑        ↑        │         │
   │        └────────┘         │
   │       fail, retry         │
   │                           │
   └── design flaw, rethink ───┘
```

## Even fan (4 branches) with a loop across it

```json
{
  "flow": [
    "ingest",
    {
      "parallel": [
        "ocr",
        "asr",
        "nlp",
        "exif"
      ]
    },
    "merge index",
    "quality gate"
  ],
  "loops": [
    {
      "from": "quality gate",
      "to": "ingest",
      "label": "below threshold, re-ingest"
    }
  ]
}
```

```
         ┌─→ ocr ──┐
         ├─→ asr ──┤
ingest ──┤         ├─→ merge index ─→ quality gate
   ↑     ├─→ nlp ──┤                        │
   │     └─→ exif ─┘                        │
   │                                        │
   └────── below threshold, re-ingest ──────┘
```

## TB funnel with return channel

```json
{
  "dir": "tb",
  "flow": [
    "1,000 traces",
    "cluster failures",
    {
      "parallel": [
        "hyp A",
        "hyp B",
        "hyp C"
      ]
    },
    {
      "parallel": [
        "eval",
        "eval",
        "eval"
      ]
    },
    "comparator",
    "PR / reject"
  ],
  "loops": [
    {
      "from": "comparator",
      "to": "cluster failures",
      "label": "no winner, re-cluster"
    }
  ]
}
```

```
    1,000 traces
          ↓
  cluster failures ←───┐
  ↙       ↓       ↘    │
hyp A   hyp B   hyp C  │
   ↓      ↓      ↓     │ no winner, re-cluster
 eval   eval   eval    │
   ↘      ↓      ↙     │
     comparator ───────┘
          ↓
     PR / reject
```

## TB two-branch diamond

```json
{
  "dir": "tb",
  "flow": [
    "incident",
    "triage",
    {
      "parallel": [
        "rollback",
        "hotfix"
      ]
    },
    "postmortem"
  ]
}
```

```
    incident
        ↓
     triage
    ↙         ↘
rollback   hotfix
    ↘         ↙
   postmortem
```

## Same refusal ladder in tree mode (60 cols instead of 150+)

```json
{
  "dir": "tree",
  "flow": [
    "user: cancel",
    "objection 1: metrics",
    {
      "branch": [
        [
          "persuaded ✓"
        ],
        [
          "insists",
          "objection 2: pause instead",
          {
            "branch": [
              [
                "takes pause ✓"
              ],
              [
                "insists",
                "objection 3: discount",
                {
                  "branch": [
                    [
                      "takes discount ✓"
                    ],
                    [
                      "insists",
                      "objection 4: keep perks 30d",
                      {
                        "branch": [
                          [
                            "relents ✓"
                          ],
                          [
                            "insists",
                            "cancel granted",
                            "exit survey"
                          ]
                        ]
                      }
                    ]
                  ]
                }
              ]
            ]
          }
        ]
      ]
    }
  ]
}
```

```
user: cancel ─→ objection 1: metrics
├─→ persuaded ✓
└─→ insists ─→ objection 2: pause instead
    ├─→ takes pause ✓
    └─→ insists ─→ objection 3: discount
        ├─→ takes discount ✓
        └─→ insists ─→ objection 4: keep perks 30d
            ├─→ relents ✓
            └─→ insists ─→ cancel granted ─→ exit survey
```

## Tree mode with a parallel group mid-flow

```json
{
  "dir": "tree",
  "flow": [
    "planner",
    {
      "parallel": [
        "agent A",
        "agent B",
        "agent C"
      ]
    },
    "synthesizer",
    "ship"
  ]
}
```

```
planner
├─ agent A
├─ agent B
└─ agent C
↓
synthesizer ─→ ship
```

## Tree mode: support triage with mixed nesting

```json
{
  "dir": "tree",
  "flow": [
    "ticket arrives",
    "classify",
    {
      "branch": [
        [
          "billing",
          "refund bot",
          {
            "branch": [
              [
                "refunded ✓"
              ],
              [
                "disputed",
                "human queue"
              ]
            ]
          }
        ],
        [
          "technical",
          "diagnose",
          {
            "parallel": [
              "check logs",
              "check status page"
            ]
          },
          "answer ✓"
        ],
        [
          "abuse report",
          "escalate to trust & safety"
        ]
      ]
    }
  ]
}
```

```
ticket arrives ─→ classify
├─→ billing ─→ refund bot
│   ├─→ refunded ✓
│   └─→ disputed ─→ human queue
├─→ technical ─→ diagnose
│   ├─ check logs
│   └─ check status page
│   ↓
│   answer ✓
└─→ abuse report ─→ escalate to trust & safety
```

## Groups nested inside a parallel fan

```json
{
  "flow": [
    "ingest",
    {
      "parallel": [
        "ocr",
        [
          "nlp",
          {
            "parallel": [
              "ner",
              "sentiment",
              "topics"
            ]
          }
        ],
        "exif"
      ]
    },
    "merge index"
  ]
}
```

```
         ┌─→ ocr ────────────────────┐
         │         ┌─→ ner ───────┐  │
ingest ──┼─→ nlp ──┼─→ sentiment ─┼──┼─→ merge index
         │         └─→ topics ────┘  │
         └─→ exif ───────────────────┘
```

## Branch inside a parallel alternative

```json
{
  "flow": [
    "request",
    {
      "parallel": [
        "cache lookup",
        [
          "origin fetch",
          {
            "branch": [
              "200 ─→ store",
              "5xx ─→ retry queue"
            ]
          }
        ]
      ]
    },
    "respond"
  ]
}
```

```
          ┌─→ cache lookup ──────────────────────────┐
request ──┤                                          ├─→ respond
          └─→ origin fetch ──┬─→ 200 ─→ store ───────┘
                             └─→ 5xx ─→ retry queue
```

## Loop into a node inside a fan, and a skip-ahead

```json
{
  "flow": [
    "plan",
    {
      "parallel": [
        "implement",
        "write docs"
      ]
    },
    "review",
    "merge"
  ],
  "loops": [
    {
      "from": "review",
      "to": "implement",
      "label": "fix"
    },
    {
      "from": "plan",
      "to": "merge",
      "label": "trivial change, skip review"
    }
  ]
}
```

```
       ┌─→ implement ──┐
plan ──┤       ↑       ├─→ review ─→ merge
  │    └─→ write docs ─┘      │        ↑
  │            │              │        │
  │            └──── fix ─────┘        │
  │                                    │
  └─── trivial change, skip review ────┘
```

## Wide labels: CJK and emoji stay aligned

```json
{
  "flow": [
    "受付",
    {
      "parallel": [
        "審査 🔍",
        "🚀 fast track",
        "manual"
      ]
    },
    "決定"
  ],
  "loops": [
    {
      "from": "決定",
      "to": "受付",
      "label": "再申請"
    }
  ]
}
```

```
       ┌─→ 審査 🔍 ───────┐
受付 ──┼─→ 🚀 fast track ─┼─→ 決定
  ↑    └─→ manual ────────┘     │
  │                             │
  └────────── 再申請 ───────────┘
```

## Width budget: a chain with loops that would be 129 columns in lr

No `dir` given, default budget 80. In `lr` this is 129 columns and soft-wraps
into garbage inside a chat code block; auto mode picks `tb`, the first mode
that fits.

```json
{
  "flow": [
    "plan (you + me)",
    "packet",
    "cx execute (memories on)",
    "my gates: typecheck + tests",
    "consult.mjs review (memories off)",
    "land"
  ],
  "loops": [
    {
      "from": "consult.mjs review (memories off)",
      "to": "cx execute (memories on)",
      "label": "cx say: corrections"
    },
    {
      "from": "land",
      "to": "packet",
      "label": "findings, revise"
    }
  ]
}
```

```
         plan (you + me)
                ↓
             packet ←─────────────────────────────────────┐
                ↓                                         │
    cx execute (memories on) ←─────┐                      │
                ↓                  │                      │
   my gates: typecheck + tests     │ cx say: corrections  │ findings, revise
                ↓                  │                      │
consult.mjs review (memories off) ─┘                      │
                ↓                                         │
              land ───────────────────────────────────────┘
```

## Width budget: a plain chain wraps into a snake

```json
{
  "flow": [
    "receive request",
    "validate schema",
    "authenticate caller",
    "load tenant config",
    "apply rate limit",
    "dispatch to handler",
    "serialize response",
    "emit metrics",
    "send"
  ]
}
```

```
receive request ─→ validate schema ─→ authenticate caller ─┐
┌──────────────────────────────────────────────────────────┘
└─→ load tenant config ─→ apply rate limit ─→ dispatch to handler ─┐
┌──────────────────────────────────────────────────────────────────┘
└─→ serialize response ─→ emit metrics ─→ send
```

## Interleaved loops cross with ╫; nested loops do not

L1 (e→a) and L2 (f→d) interleave, so L2's channel must pass through L1's
arc; the crossing is drawn as ╫ (no connection; ┼ is a fan junction) and
the label keeps a dash clear of it. The inner
loop (c→b) nests cleanly.

```json
{
  "flow": [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f"
  ],
  "loops": [
    {
      "from": "c",
      "to": "b",
      "label": "in"
    },
    {
      "from": "e",
      "to": "a",
      "label": "L1"
    },
    {
      "from": "f",
      "to": "d",
      "label": "L2"
    }
  ]
}
```

```
a ─→ b ─→ c ─→ d ─→ e ─→ f
↑    ↑    │    ↑    │    │
│    └ in ┘    │    │    │
│              │    │    │
└─────── L1 ───╫────┘    │
               │         │
               └── L2 ───┘
```

