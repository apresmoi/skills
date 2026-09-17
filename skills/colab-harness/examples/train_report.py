"""Training report: the evidence a fine-tune has to produce to count as a result.

Standard library only, single file, no imports from this package — so a job script can inline it
(the harness uploads one file per job) or download it at a pinned ref.

What it records, and why each one changes a decision:

  fraction ladder   train on 25/50/100% of the data and score each stage; the shape says whether
                    more labelling is worth buying, which no single end-of-run number can tell you
  validation curve  score during training, not only at the end: the step where validation stops
                    improving is the checkpoint to keep, and a rising gap is overfitting
  baselines         the untrained model and a trivial always-the-commonest-answer predictor;
                    a score is meaningless until it clears both
  uncertainty       bootstrap interval on every rate, so a 6-point gap on 15 examples is not
                    mistaken for progress
  ceiling           optional: how well the label sources agree with each other; a student that
                    matches the ceiling is finished, not failing
  leakage           ids (and near-duplicate prompts) shared between train and eval
  cost              GPU seconds and compute units, so the next curve can be priced

Usage:

    rep = Report(run="labels-r2", model=MODEL_ID, out_dir=OUT)
    rep.config(epochs=2, lr=1e-4, seed=17, max_len=4096)
    rep.data(train=886, val=435, train_blocks=296, splits={"train": 296, "val": 145})
    rep.leakage(train_ids, val_ids, train_prompts, val_prompts)
    rep.baseline("untrained", evaluate(base_model, sample))
    rep.baseline("majority", majority_class_scores(sample))
    ...
    rep.stage(fraction=0.25, examples=220, metrics=evaluate(model, sample), train={"steps": 55})
    rep.curve_point(step=50, split="val", loss=0.83, metrics={"labels.irony_acc": 0.6})
    rep.cost(gpu="NVIDIA L4", seconds=4539, units_per_hour=1.54)
    rep.write()           # -> training-report.json + REPORT.md next to the job's outputs
"""

import json
import math
import os
import random
import time
from pathlib import Path

__all__ = ["Report", "bootstrap_ci", "majority_baseline", "ascii_trend"]

# --- self-contained SVG (no CDN, no JS): the report must open from a file:// path, offline ---

_CSS = """
:root { --bg:#fbfbfa; --fg:#1f1f1c; --muted:#6b6b66; --line:#dcdcd6; --ok:#1f7a4d; --bad:#b3261e; --warn:#8a6d1f; --accent:#2f6fdb; }
@media (prefers-color-scheme: dark) { :root { --bg:#16161a; --fg:#ecece8; --muted:#a0a09a; --line:#33333a; --ok:#59c48b; --bad:#ef6a62; --warn:#d9b44a; --accent:#7aa5ef; } }
* { box-sizing:border-box } body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
  font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
main { max-width:920px; margin:0 auto } h1 { font-size:24px; margin:0 0 4px } h2 { font-size:17px; margin:32px 0 10px }
.sub { color:var(--muted); margin:0 0 24px } .cards { display:flex; flex-wrap:wrap; gap:12px }
.card { flex:1 1 200px; border:1px solid var(--line); border-radius:10px; padding:12px 14px; background:transparent }
.card h3 { font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 6px }
.card .big { font-size:18px; font-weight:600 } .ok{color:var(--ok)} .bad{color:var(--bad)} .warn{color:var(--warn)}
table { border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums; margin:8px 0 }
th,td { border-bottom:1px solid var(--line); padding:6px 8px; text-align:right } th:first-child,td:first-child { text-align:left }
th { font-weight:600; color:var(--muted); font-size:13px } figure { margin:12px 0 } figcaption { color:var(--muted); font-size:13px; margin-top:4px }
ul { padding-left:18px } li { margin:3px 0 } code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:1px 5px; border-radius:4px }
"""


def _svg_lines(series, width=860, height=260, xlabel="", ylabel="", pad=46):
    """series: {name: [(x, y), ...]} -> one inline SVG, axes labelled with real values."""
    pts = [p for v in series.values() for p in v]
    if len(pts) < 2:
        return ""
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if x1 == x0:
        x1 = x0 + 1
    if y1 == y0:
        y0, y1 = y0 - 0.01, y1 + 0.01
    span = (y1 - y0) * 0.12
    y0, y1 = y0 - span, y1 + span
    sx = lambda x: pad + (x - x0) / (x1 - x0) * (width - pad - 14)
    sy = lambda y: height - pad - (y - y0) / (y1 - y0) * (height - pad - 16)
    colors = ["var(--accent)", "var(--bad)", "var(--ok)", "var(--warn)", "var(--muted)"]
    out = [f'<svg viewBox="0 0 {width} {height}" width="100%" role="img" aria-label="{xlabel} vs {ylabel}">']
    for i in range(4):                                     # horizontal guides + y ticks
        y = y0 + (y1 - y0) * i / 3
        out.append(f'<line x1="{pad}" y1="{sy(y):.1f}" x2="{width - 14}" y2="{sy(y):.1f}" stroke="var(--line)" stroke-width="1"/>')
        out.append(f'<text x="{pad - 6}" y="{sy(y) + 4:.1f}" font-size="11" fill="var(--muted)" text-anchor="end">{y:.3g}</text>')
    for i, (name, vals) in enumerate(series.items()):
        c = colors[i % len(colors)]
        pth = " ".join(f"{'M' if j == 0 else 'L'}{sx(x):.1f},{sy(y):.1f}" for j, (x, y) in enumerate(sorted(vals)))
        out.append(f'<path d="{pth}" fill="none" stroke="{c}" stroke-width="2"/>')
        out += [f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="3.2" fill="{c}"/>' for x, y in vals]
        out.append(f'<text x="{pad + 8 + i * 150}" y="14" font-size="12" fill="{c}">■ {name}</text>')
    out.append(f'<text x="{pad}" y="{height - 12}" font-size="11" fill="var(--muted)">{x0:g}</text>')
    out.append(f'<text x="{width - 14}" y="{height - 12}" font-size="11" fill="var(--muted)" text-anchor="end">{x1:g}</text>')
    out.append(f'<text x="{width / 2:.0f}" y="{height - 12}" font-size="11" fill="var(--muted)" text-anchor="middle">{xlabel}</text>')
    out.append("</svg>")
    return "".join(out)


def _esc(x):
    return (str(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def bootstrap_ci(values, iters=2000, alpha=0.05, seed=0):
    """Percentile bootstrap interval for the mean of a small sample (rates, accuracies, scores)."""
    xs = [float(v) for v in values if v is not None]
    if not xs:
        return None
    if len(xs) == 1:
        return {"n": 1, "mean": xs[0], "lo": xs[0], "hi": xs[0], "half_width": 0.0}
    rng = random.Random(seed)
    means = []
    for _ in range(iters):
        means.append(sum(rng.choice(xs) for _ in xs) / len(xs))
    means.sort()
    lo = means[int(alpha / 2 * iters)]
    hi = means[min(iters - 1, int((1 - alpha / 2) * iters))]
    mean = sum(xs) / len(xs)
    return {"n": len(xs), "mean": round(mean, 4), "lo": round(lo, 4), "hi": round(hi, 4),
            "half_width": round((hi - lo) / 2, 4)}


def majority_baseline(gold_values):
    """Score of always answering the commonest value — the floor any real model must clear."""
    vals = [v for v in gold_values if v is not None]
    if not vals:
        return None
    counts = {}
    for v in vals:
        key = json.dumps(v, sort_keys=True) if isinstance(v, (list, dict)) else v
        counts[key] = counts.get(key, 0) + 1
    top, n = max(counts.items(), key=lambda kv: kv[1])
    return {"answer": top, "accuracy": round(n / len(vals), 4), "n": len(vals)}


def ascii_trend(points, width=44, height=6):
    """Tiny plot of (x, y) pairs; a ladder or a loss curve is easier to read as a shape."""
    pts = [(float(x), float(y)) for x, y in points if y is not None]
    if len(pts) < 2:
        return ""
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if x1 == x0 or y1 == y0:
        return ""
    grid = [[" "] * width for _ in range(height)]
    for x, y in pts:
        col = int((x - x0) / (x1 - x0) * (width - 1))
        row = height - 1 - int((y - y0) / (y1 - y0) * (height - 1))
        grid[row][col] = "*"
    rows = ["".join(r) for r in grid]
    return "\n".join([f"{y1:.3f} |{rows[0]}"] + [f"      |{r}" for r in rows[1:-1]] +
                     [f"{y0:.3f} |{rows[-1]}", "      +" + "-" * width,
                      f"       {x0:g}{' ' * max(1, width - len(f'{x0:g}{x1:g}'))}{x1:g}"])


def _flat(metrics, prefix=""):
    """Nested per-task metrics -> flat dotted keys, so stages can be compared field by field."""
    out = {}
    for k, v in (metrics or {}).items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flat(v, f"{key}."))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            out[key] = v
    return out


class Report:
    # Metrics where smaller is better: gains, verdicts and baseline comparisons all flip for these.
    LOWER_IS_BETTER = ("loss", "error", "err", "perplexity", "ppl", "abs_err", "rate_invalid")

    def _lower(self, key):
        tail = key.split(".")[-1].lower()
        return any(tail == m or tail.endswith("_" + m) or m in tail for m in self.lower_is_better)

    def __init__(self, run, model, out_dir=None, lower_is_better=None):
        self.r = {"run": run, "model": model, "started": time.time(), "schema": "training-report-v1",
                  "config": {}, "data": {}, "baselines": {}, "stages": [], "curve": [],
                  "leakage": None, "ceiling": None, "cost": None, "notes": []}
        self.out = Path(out_dir or os.environ.get("HARNESS_JOB_DIR", "."))
        self.lower_is_better = tuple(lower_is_better) if lower_is_better is not None else self.LOWER_IS_BETTER
        self.r["lower_is_better"] = list(self.lower_is_better)

    def config(self, **kw):
        self.r["config"].update(kw); return self

    def data(self, **kw):
        self.r["data"].update(kw); return self

    def note(self, text):
        self.r["notes"].append(text); return self

    def leakage(self, train_ids, eval_ids, train_prompts=None, eval_prompts=None):
        shared = sorted(set(train_ids) & set(eval_ids))
        dup = 0
        if train_prompts is not None and eval_prompts is not None:
            seen = {p.strip()[:2000] for p in train_prompts}
            dup = sum(1 for p in eval_prompts if p.strip()[:2000] in seen)
        self.r["leakage"] = {"shared_ids": len(shared), "examples": shared[:10], "duplicate_prompts": dup,
                             "clean": not shared and dup == 0}
        return self

    def baseline(self, name, metrics):
        self.r["baselines"][name] = _flat(metrics); return self

    def ceiling(self, description, metrics):
        self.r["ceiling"] = {"description": description, **_flat(metrics)}; return self

    def stage(self, fraction, examples, metrics, train=None, per_example=None):
        """One rung of the ladder: the model trained on `fraction` of the data, scored on the same eval set."""
        entry = {"fraction": fraction, "examples": examples, "metrics": _flat(metrics), "train": train or {}}
        if per_example:
            entry["ci"] = {k: bootstrap_ci(v) for k, v in per_example.items()}
        self.r["stages"].append(entry); return self

    def curve_point(self, step, split, loss=None, metrics=None):
        self.r["curve"].append({"step": step, "split": split, "loss": loss, "metrics": _flat(metrics)}); return self

    def cost(self, gpu, seconds, units_per_hour=None):
        self.r["cost"] = {"gpu": gpu, "seconds": round(seconds, 1),
                          "units": round(units_per_hour * seconds / 3600, 2) if units_per_hour else None}
        return self

    # --- verdicts: the report should say what it means, not leave it to the reader ---

    def _headline(self):
        if not self.r["stages"]:
            return []
        keys = [k for k in self.r["stages"][-1]["metrics"] if not k.endswith(".n")]
        return sorted(keys)[:12]

    def _gains(self):
        out = {}
        if len(self.r["stages"]) < 2:
            return out
        first, last = self.r["stages"][0], self.r["stages"][-1]
        mid = self.r["stages"][len(self.r["stages"]) // 2]
        for k in self._headline():
            a, b, c = first["metrics"].get(k), mid["metrics"].get(k), last["metrics"].get(k)
            if None in (a, b, c):
                continue
            sign = -1 if self._lower(k) else 1          # report gains as improvements, whatever the direction
            early, late = sign * (b - a), sign * (c - b)
            ci = (last.get("ci") or {}).get(k, {})
            hw = ci.get("half_width")
            # With an interval the verdict is a comparison against noise; without one it is only a
            # threshold on the last doubling, which cannot tell a small real gain from sampling error.
            verdict = ("noise" if hw is not None and abs(late) < hw else
                       "still climbing" if late > 0.02 else
                       "flattening" if early > late else "flat")
            out[k] = {"first": a, "mid": b, "last": c, "early_gain": round(early, 4),
                      "late_gain": round(late, 4), "lower_is_better": self._lower(k), "verdict": verdict,
                      "basis": "interval" if hw is not None else "threshold-only (pass per_example for an interval)",
                      "half_width": hw}
        return out

    def _overfit(self):
        tr = [(c["step"], c["loss"]) for c in self.r["curve"] if c["split"] == "train" and c["loss"] is not None]
        va = [(c["step"], c["loss"]) for c in self.r["curve"] if c["split"] == "val" and c["loss"] is not None]
        if len(va) < 2:
            return {"status": "unknown", "why": "fewer than two validation points; score during training, not only at the end"}
        best = min(va, key=lambda p: p[1])
        last = va[-1]
        gap = None
        if tr:
            near = min(tr, key=lambda p: abs(p[0] - last[0]))
            gap = round(last[1] - near[1], 4)
        status = "overfitting" if last[1] > best[1] * 1.05 and last[0] > best[0] else "ok"
        return {"status": status, "best_step": best[0], "best_val_loss": round(best[1], 4),
                "final_val_loss": round(last[1], 4), "train_val_gap": gap,
                "keep_checkpoint_at_step": best[0]}

    def verdicts(self):
        return {"data_scaling": self._gains(), "overfitting": self._overfit(),
                "leakage": self.r["leakage"], "baselines_cleared": self._cleared()}

    def _cleared(self):
        if not self.r["stages"] or not self.r["baselines"]:
            return None
        last = self.r["stages"][-1]["metrics"]
        out = {}
        for name, b in self.r["baselines"].items():
            worse = [k for k, v in b.items() if k in last and (last[k] > v if self._lower(k) else last[k] < v)]
            out[name] = {"cleared": not worse, "metrics_below_baseline": worse}
        return out

    def markdown(self):
        r, v = self.r, self.verdicts()
        L = [f"# {r['run']}", "", f"`{r['model']}` · {r['data']}", ""]
        if r["cost"]:
            L += [f"cost: {r['cost']['gpu']}, {round(r['cost']['seconds'] / 60)} min"
                  + (f", ≈{r['cost']['units']} units" if r["cost"]["units"] else ""), ""]
        if r["stages"]:
            keys = self._headline()
            L += ["## Data ladder", "", "| fraction | examples | " + " | ".join(keys) + " |",
                  "|---|---:|" + "---:|" * len(keys)]
            for s in r["stages"]:
                L.append(f"| {s['fraction']:.0%} | {s['examples']} | "
                         + " | ".join(f"{s['metrics'].get(k, float('nan')):.3f}" for k in keys) + " |")
            L.append("")
            for k, g in v["data_scaling"].items():
                L.append(f"- **{k}**{' (lower is better)' if g['lower_is_better'] else ''}: "
                         f"{g['first']:.3f} → {g['mid']:.3f} → {g['last']:.3f} "
                         f"(improvement on the last doubling {g['late_gain']:+.3f}) — **{g['verdict']}**"
                         + ("" if g["half_width"] is not None else " *(no interval: verdict is a threshold, not a test)*"))
            trend = ascii_trend([(s["fraction"], s["metrics"].get(self._headline()[0])) for s in r["stages"]])
            if trend:
                L += ["", "```", trend, "```"]
        o = v["overfitting"]
        L += ["", "## Overfitting", "", f"- status: **{o['status']}**"
              + (f" · best val loss {o['best_val_loss']} at step {o['best_step']}, final {o['final_val_loss']}"
                 if o["status"] != "unknown" else f" ({o['why']})")]
        if o.get("train_val_gap") is not None:
            L.append(f"- train/val gap at the end: {o['train_val_gap']}")
        if r["baselines"]:
            L += ["", "## Baselines", ""]
            for name, b in r["baselines"].items():
                cleared = (v["baselines_cleared"] or {}).get(name, {})
                L.append(f"- **{name}**: {'cleared' if cleared.get('cleared') else 'NOT cleared on ' + ', '.join(cleared.get('metrics_below_baseline', []))}")
        if r["ceiling"]:
            L += ["", f"## Ceiling", "", f"- {r['ceiling']['description']}"]
        if r["leakage"]:
            lk = r["leakage"]
            L += ["", "## Leakage", "", f"- shared ids: {lk['shared_ids']} · duplicate prompts: {lk['duplicate_prompts']} → "
                  + ("clean" if lk["clean"] else "**CONTAMINATED — the eval numbers are not valid**")]
        if r["notes"]:
            L += ["", "## Notes", ""] + [f"- {n}" for n in r["notes"]]
        return "\n".join(L) + "\n"

    def html(self):
        """Self-contained page: charts as inline SVG, no scripts, opens from disk offline."""
        r, v = self.r, self.verdicts()
        o, lk = v["overfitting"], r["leakage"]
        cards = []
        gains = v["data_scaling"]
        if gains:
            worst = max(gains.items(), key=lambda kv: abs(kv[1]["late_gain"]))
            cls = {"still climbing": "ok", "flattening": "warn", "noise": "bad", "flat": "bad"}.get(worst[1]["verdict"], "")
            cards.append(("More data?", f'<span class="{cls}">{worst[1]["verdict"]}</span>',
                          f'{_esc(worst[0])} {worst[1]["mid"]:.3f} → {worst[1]["last"]:.3f} on the last doubling'))
        cards.append(("Overfitting", f'<span class="{"bad" if o["status"] == "overfitting" else "ok" if o["status"] == "ok" else "warn"}">{o["status"]}</span>',
                      f'keep step {o["keep_checkpoint_at_step"]}' if o.get("keep_checkpoint_at_step") else _esc(o.get("why", ""))))
        if v["baselines_cleared"]:
            bad = [n for n, b in v["baselines_cleared"].items() if not b["cleared"]]
            cards.append(("Baselines", f'<span class="{"bad" if bad else "ok"}">{"below " + ", ".join(bad) if bad else "cleared"}</span>',
                          " · ".join(r["baselines"])))
        if lk:
            cards.append(("Leakage", f'<span class="{"ok" if lk["clean"] else "bad"}">{"clean" if lk["clean"] else "contaminated"}</span>',
                          f'{lk["shared_ids"]} shared ids · {lk["duplicate_prompts"]} duplicate prompts'))
        if r["cost"]:
            cards.append(("Cost", f'{round(r["cost"]["seconds"] / 60)} min', f'{_esc(r["cost"]["gpu"])}'
                          + (f' · ≈{r["cost"]["units"]} units' if r["cost"]["units"] else "")))
        H = [f'<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
             f"<title>{_esc(r['run'])} — training report</title><style>{_CSS}</style><main>",
             f"<h1>{_esc(r['run'])}</h1>",
             f"<p class=sub><code>{_esc(r['model'])}</code> · " + " · ".join(f"{k}: {_esc(val)}" for k, val in r["data"].items()) + "</p>",
             '<div class=cards>' + "".join(f"<div class=card><h3>{t}</h3><div class=big>{b}</div><div class=sub style='margin:2px 0 0'>{s2}</div></div>"
                                           for t, b, s2 in cards) + "</div>"]
        if r["stages"]:
            keys = self._headline()
            ladder = {k: [(st["fraction"], st["metrics"][k]) for st in r["stages"] if k in st["metrics"]] for k in keys}
            ladder = {k: v2 for k, v2 in ladder.items() if len(v2) > 1}
            H += ["<h2>Data ladder</h2>",
                  f'<figure>{_svg_lines(ladder, xlabel="fraction of training data")}'
                  f"<figcaption>Each rung is a fresh adapter trained on that share of the data, scored on the same eval set. "
                  f"A flat right-hand end means more labelling buys little.</figcaption></figure>",
                  "<table><tr><th>fraction</th><th>examples</th>" + "".join(f"<th>{_esc(k)}</th>" for k in keys) + "</tr>"]
            for st in r["stages"]:
                H.append(f"<tr><td>{st['fraction']:.0%}</td><td>{st['examples']}</td>"
                         + "".join(f"<td>{st['metrics'].get(k, float('nan')):.3f}"
                                   + (f" <span class=sub>±{st['ci'][k]['half_width']:.2f}</span>" if st.get("ci", {}).get(k) else "")
                                   + "</td>" for k in keys) + "</tr>")
            H += ["</table>", "<ul>"] + [f"<li><b>{_esc(k)}</b>{' <span class=sub>(lower is better)</span>' if g['lower_is_better'] else ''}: "
                                         f"{g['first']:.3f} → {g['mid']:.3f} → {g['last']:.3f} "
                                         f"(last doubling {g['late_gain']:+.3f}) — <b>{g['verdict']}</b>"
                                         + ("" if g["half_width"] is not None else
                                            ' <span class=sub>(no interval — threshold only)</span>') + "</li>"
                                         for k, g in gains.items()] + ["</ul>"]
        curve = {}
        for c in r["curve"]:
            if c["loss"] is not None:
                curve.setdefault(f"{c['split']} loss", []).append((c["step"], c["loss"]))
        if curve:
            H += ["<h2>Training curve</h2>", f'<figure>{_svg_lines(curve, xlabel="optimizer step")}'
                  "<figcaption>Validation rising while training falls is overfitting; the lowest validation point is the checkpoint to keep."
                  "</figcaption></figure>"]
        if r["baselines"]:
            H += ["<h2>Baselines</h2><table><tr><th>baseline</th><th>metric</th><th>value</th></tr>"]
            for name, b in r["baselines"].items():
                for k, val in b.items():
                    H.append(f"<tr><td>{_esc(name)}</td><td>{_esc(k)}</td><td>{val:.3f}</td></tr>")
            H.append("</table>")
        if r["ceiling"]:
            H += ["<h2>Ceiling</h2>", f"<p>{_esc(r['ceiling']['description'])}</p>"]
        if r["notes"]:
            H += ["<h2>Notes</h2><ul>"] + [f"<li>{_esc(n)}</li>" for n in r["notes"]] + ["</ul>"]
        H.append("</main></html>")
        return "".join(H)

    def write(self):
        self.r["finished"] = time.time()
        self.r["verdicts"] = self.verdicts()
        self.out.mkdir(parents=True, exist_ok=True)
        (self.out / "training-report.json").write_text(json.dumps(self.r, ensure_ascii=False, indent=1))
        (self.out / "REPORT.md").write_text(self.markdown())
        (self.out / "REPORT.html").write_text(self.html())
        print("TRAINING_REPORT", json.dumps(self.r["verdicts"], ensure_ascii=False)[:1500], flush=True)
        return self.r
