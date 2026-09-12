#!/usr/bin/env node
// arrow-diagram — render ASCII arrow diagrams from a JSON spec.
// Usage:
//   node render.mjs graph.json
//   node render.mjs '{"dir":"lr","flow":[...]}'
//   echo '{...}' | node render.mjs
//
// Spec:
// {
//   "dir": "lr" | "tb",            // default "lr"
//   "flow": [                       // sequence of stages
//     "node label",                 // plain node
//     { "parallel": [               // fan-out / fan-in between neighbors
//        "branch label",            //   single node branch
//        ["a", "b"]                 //   chain branch (LR only)
//     ] }
//   ],
//   "loops": [                      // optional (LR only): back-edges drawn below
//     { "from": "tests", "to": "planner", "label": "fixer ← fail" }
//   ]
// }

import { readFileSync } from 'node:fs';

// ---------- display width ----------
// Box drawing relies on column alignment, so pad by DISPLAY width, not
// string length: CJK, fullwidth forms, and emoji occupy two columns.
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Emoji_Presentation}/u;
const ZERO = /[\u200B-\u200D\uFE0F\p{M}]/u;
function dw(str) {
  let w = 0;
  for (const ch of str) {
    if (ZERO.test(ch)) continue;
    w += WIDE.test(ch) ? 2 : 1;
  }
  return w;
}
function padTo(str, width) { return str + ' '.repeat(Math.max(width - dw(str), 0)); }

const USAGE = `arrow-diagram — render ASCII arrow diagrams from a JSON spec.

  node render.mjs graph.json          # spec from a file
  node render.mjs '{"flow":[...]}'    # inline JSON
  echo '{...}' | node render.mjs      # spec on stdin

Spec: { "dir": "lr"|"tb"|"tree", "flow": [...], "loops": [...] }
  flow item : "label" | {"parallel":[alt,...]} | {"branch":[alt,...]}
  alt       : "label" | [nested flow]
  loop      : {"from":"label","to":"label","label":"text"}   (lr, tb)

Exit 0 on success, 2 on a spec error (message on stderr).`;

function fail(msg) { console.error('arrow-diagram: ' + msg); process.exit(2); }


// Reject shapes a mode cannot draw instead of printing "[object Object]".
function validate(flow, mode, depth = 0) {
  flow.forEach((item, k) => {
    if (typeof item === 'string') return;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(`flow item ${k} must be a string, {"parallel":[...]}, or {"branch":[...]}`);
    }
    const kind = Array.isArray(item.parallel) ? 'parallel' : Array.isArray(item.branch) ? 'branch' : null;
    if (!kind) fail(`flow item ${k} must be a string, {"parallel":[...]}, or {"branch":[...]}`);
    if (kind === 'branch' && mode === 'tb') fail('"branch" is not supported in tb mode (use lr or tree)');
    if (kind === 'branch' && k < flow.length - 1) fail('"branch" must be the last item of its flow');
    if (mode === 'tb' && depth > 0) fail('tb mode does not support nested groups');
    for (const alt of item[kind]) {
      if (typeof alt === 'string') continue;
      if (!Array.isArray(alt)) fail(`each ${kind} alternative must be a string or a nested flow array`);
      if (mode === 'tb') fail('tb mode alternatives must be plain labels (use lr for chains)');
      validate(alt, mode, depth + 1);
    }
  });
}


// ---------- LR ----------

function textBlock(s) { return { lines: [s], anchor: 0, nodes: [{ label: s, x: 0, row: 0 }] }; }
function shift(nodes, dx, dy) { return nodes.map(n => ({ label: n.label, x: n.x + dx, row: n.row + dy })); }
function blockWidth(b) { return Math.max(...b.lines.map(l => dw(l))); }

// Join two blocks horizontally, connecting their anchor rows with `sep`.
function hjoin(a, b, sep) {
  const aw = blockWidth(a);
  const above = Math.max(a.anchor, b.anchor);
  const below = Math.max(a.lines.length - a.anchor, b.lines.length - b.anchor);
  const lines = [];
  for (let i = 0; i < above + below; i++) {
    const ai = i - (above - a.anchor);
    const bi = i - (above - b.anchor);
    const al = ai >= 0 && ai < a.lines.length ? a.lines[ai] : '';
    const bl = bi >= 0 && bi < b.lines.length ? b.lines[bi] : '';
    const s = i === above ? sep : ' '.repeat(sep.length);
    lines.push(padTo(al, aw) + s + bl);
  }
  const nodes = shift(a.nodes, 0, above - a.anchor).concat(shift(b.nodes, aw + sep.length, above - b.anchor));
  return { lines, anchor: above, nodes };
}

function branchText(br) { return Array.isArray(br) ? br.join(' ─→ ') : String(br); }

// A parallel alternative is a label or a nested flow. Nested flows may hold
// their own parallel/branch groups, so they are built as blocks, not joined
// as text; a multi-row block keeps its own anchor row for the rails.
function altBlock(alt) { return Array.isArray(alt) ? buildFlow(alt) : textBlock(String(alt)); }

// ┌─→ a ─┐         Odd branch count: trunk passes through the middle branch (┼).
// ┼─→ b ─┼─→       Even count: a connector-only row is inserted in the middle
// └─→ c ─┘         (left ┤, right ├), branches use ├ / ┤, pass-through rows │.
function parallelBlock(branches) {
  const n = branches.length;
  if (n < 2) return n === 1 ? altBlock(branches[0]) : textBlock('');
  const blocks = branches.map(altBlock);
  const inner = Math.max(...blocks.map(blockWidth));
  const odd = n % 2 === 1;
  // rows: {text, kind, alt} — kind 'alt' carries an alternative's anchor row,
  // 'pass' a non-anchor row of a multi-row alternative, 'gap' the
  // connector-only row inserted in the middle of an even fan.
  const rows = [];
  const nodes = [];
  let anchor = 0;
  blocks.forEach((b, i) => {
    if (!odd && i === n / 2) { rows.push({ text: ' '.repeat(inner + 5), kind: 'gap', alt: -1 }); anchor = rows.length - 1; }
    nodes.push(...shift(b.nodes, 4, rows.length));
    b.lines.forEach((ln, r) => {
      const isAnchor = r === b.anchor;
      let text;
      if (isAnchor) {
        // label, one space, then rail dashes out to the shared right edge;
        // a nested block already ends in a box glyph, so no space before dashes
        const gap = /[┐┘┤├┼]$/.test(ln) ? '' : ' ';
        text = '─→ ' + ln + gap + '─'.repeat(inner + 2 - dw(ln) - gap.length);
      } else {
        text = '   ' + padTo(ln, inner) + '  ';
      }
      rows.push({ text, kind: isAnchor ? 'alt' : 'pass', alt: i });
      if (odd && i === (n - 1) / 2 && isAnchor) anchor = rows.length - 1;
    });
  });
  const firstAnchor = rows.findIndex(r => r.kind === 'alt');
  const lastAnchor = rows.length - 1 - [...rows].reverse().findIndex(r => r.kind === 'alt');
  const lines = rows.map((row, i) => {
    let L, R;
    if (i < firstAnchor || i > lastAnchor) { L = ' '; R = ' '; }
    else if (i === firstAnchor) { L = '┌'; R = '┐'; }
    else if (i === lastAnchor) { L = '└'; R = '┘'; }
    else if (i === anchor) { L = odd ? '┼' : '┤'; R = odd ? '┼' : '├'; }
    else if (row.kind === 'alt') { L = '├'; R = '┤'; }
    else { L = '│'; R = '│'; }
    return L + row.text + R;
  });
  return { lines, anchor, nodes };
}

// A ──┬─→ B          Terminal bifurcation: alternatives never reconverge.
//     ├─→ C ─→ D     Each alternative is itself a flow (may nest further
//     └─→ E          branches). Must be the last item of its flow.
function branchBlock(alts) {
  const blocks = alts.map(f => buildFlow(Array.isArray(f) ? f : [f]));
  const lines = [];
  const nodes = [];
  let anchor = 0;
  blocks.forEach((b, i) => {
    const first = i === 0, last = i === blocks.length - 1;
    nodes.push(...shift(b.nodes, 4, lines.length));
    b.lines.forEach((ln, r) => {
      let pre;
      if (r === b.anchor) pre = (first ? '┬' : last ? '└' : '├') + '─→ ';
      else if ((first && r < b.anchor) || (last && r > b.anchor)) pre = '    ';
      else pre = '│   ';
      lines.push(pre + ln);
    });
    if (first) anchor = b.anchor;
  });
  return { lines, anchor, nodes };
}

function buildFlow(flow) {
  let acc = null;
  let prevParallel = false;
  flow.forEach((item, k) => {
    let blk = null, isPar = false, isBranch = false;
    if (typeof item === 'object' && item !== null) {
      if (Array.isArray(item.parallel)) { blk = parallelBlock(item.parallel); isPar = true; }
      else if (Array.isArray(item.branch)) { blk = branchBlock(item.branch); isBranch = true; }
    }
    if (!blk) blk = textBlock(branchText(item));
    if (isBranch && k < flow.length - 1) fail('"branch" must be the last item of its flow');
    if (!acc) { acc = blk; prevParallel = isPar; return; }
    const sep = isPar || isBranch ? ' ──' : prevParallel ? '─→ ' : ' ─→ ';
    acc = hjoin(acc, blk, sep);
    prevParallel = isPar;
  });
  return acc;
}

function renderLR(spec) {
  const built = buildFlow(spec.flow);
  let lines = built.lines.slice();

  // Write ch at (row, x) only into empty space, so channels never clobber text.
  const setChar = (row, x, ch) => {
    const line = padTo(lines[row] ?? '', x + 1);
    // walk to the code-point index at display column x
    let col = 0, i = 0;
    const cps = [...line];
    while (i < cps.length && col < x) { col += dw(cps[i]); i++; }
    if (col !== x || cps[i] !== ' ') return;   // inside a wide glyph, or occupied
    cps[i] = ch;
    lines[row] = cps.join('');
  };

  for (const loop of spec.loops ?? []) {
    // Endpoints resolve against node positions recorded during layout, so
    // "agent" never lands inside "coding agent" and labels may contain spaces.
    const at = label => {
      const hits = built.nodes.filter(n => n.label === label);
      if (hits.length === 0) fail(`loop endpoint "${label}" is not a node label in the flow`);
      if (hits.length > 1) fail(`loop endpoint "${label}" matches ${hits.length} nodes; make the label unique`);
      return hits[0];
    };
    const from = at(loop.from), to = at(loop.to);
    const cx = n => n.x + Math.floor(dw(n.label) / 2);
    const fromX = cx(from), toX = cx(to);
    const lo = Math.min(fromX, toX), hi = Math.max(fromX, toX);

    lines.push('');                       // breathing room above this loop's arc
    const arcRow = lines.length;

    // Drop both channels from their node rows down to the arc: arrowhead
    // directly under the destination, plain rails the rest of the way.
    for (let r = from.row + 1; r < arcRow; r++) setChar(r, fromX, '│');
    for (let r = to.row + 1; r < arcRow; r++) setChar(r, toX, r === to.row + 1 ? '↑' : '│');

    const label = loop.label ?? '';
    const span = Math.max(hi - lo - 1, 0);
    const inline = label && dw(label) + 2 <= span;
    const fill = inline ? centerIn('─', span, ' ' + label + ' ') : '─'.repeat(span);
    lines.push(' '.repeat(lo) + '└' + fill + '┘');
    if (label && !inline) {
      const start = Math.max(Math.floor((lo + hi) / 2) - Math.floor(dw(label) / 2), 0);
      lines.push(' '.repeat(start) + label);
    }
  }
  return lines.join('\n');
}

// ---------- TREE ----------
// Chains stay horizontal; every nesting level costs 4 columns instead of the
// full width of the parent chain. Use for deep branch ladders.
function renderTree(spec) {
  const lines = [];
  walkTree(spec.flow, '', '', lines);
  return lines.join('\n');
}

function walkTree(flow, firstPrefix, contIndent, lines) {
  const chain = [];
  for (let k = 0; k < flow.length; k++) {
    const item = flow[k];
    const obj = typeof item === 'object' && item !== null;
    const isBranch = obj && Array.isArray(item.branch);
    const alts = isBranch ? item.branch : obj && Array.isArray(item.parallel) ? item.parallel : null;
    if (!alts) { chain.push(branchText(item)); continue; }

    lines.push(firstPrefix + chain.join(' ─→ '));
    const arrow = isBranch ? '─→ ' : '─ ';
    alts.forEach((alt, i) => {
      const last = i === alts.length - 1;
      walkTree(Array.isArray(alt) ? alt : [alt],
        contIndent + (last ? '└' : '├') + arrow,
        contIndent + (last ? ' ' : '│') + ' '.repeat(arrow.length),
        lines);
    });
    if (!isBranch && k < flow.length - 1) {
      lines.push(contIndent + '↓');
      walkTree(flow.slice(k + 1), contIndent, contIndent, lines);
    }
    return;
  }
  lines.push(firstPrefix + chain.join(' ─→ '));
}

function centerIn(fillCh, span, text) {
  const w = dw(text);
  if (w >= span) return text;
  const left = Math.floor((span - w) / 2);
  return fillCh.repeat(left) + text + fillCh.repeat(span - w - left);
}

// ---------- TB ----------

function renderTB(spec) {
  const items = spec.flow;
  const GAP = 3;
  // compute canvas width from widest stage
  let maxW = 0;
  for (const it of items) {
    if (typeof it === 'object' && Array.isArray(it.parallel)) {
      const labels = it.parallel.map(branchText);
      if (labels.length > 3) {
        fail('tb mode supports at most 3 parallel branches (use "lr")');
      }
      maxW = Math.max(maxW, labels.reduce((s, l) => s + dw(l), 0) + GAP * (labels.length - 1));
    } else maxW = Math.max(maxW, dw(branchText(it)));
  }
  const C = Math.floor(maxW / 2);
  const lines = [];
  const put = (text, center) => {
    const start = Math.max(center - Math.floor(dw(text) / 2), 0);
    lines.push(' '.repeat(start) + text);
  };
  const putMulti = pairs => { // [[text, center], ...] on one row
    let row = '';
    for (const [text, center] of pairs.sort((a, b) => a[1] - b[1])) {
      const start = Math.max(center - Math.floor(dw(text) / 2), dw(row));
      row = padTo(row, start) + text;
    }
    lines.push(row);
  };
  let prevPar = null; // centers of previous parallel row
  const rowOf = new Map(); // node label -> line index (for loop endpoints)
  items.forEach((it, idx) => {
    const isPar = typeof it === 'object' && Array.isArray(it.parallel);
    if (!isPar) {
      const label = branchText(it);
      if (idx > 0) {
        if (prevPar) {
          putMulti(prevPar.length === 2
            ? [['↘', prevPar[0]], ['↙', prevPar[1]]]
            : [['↘', prevPar[0]], ['↓', prevPar[1]], ['↙', prevPar[2]]]);
        } else put('↓', C);
      }
      put(label, C);
      rowOf.set(label, lines.length - 1);
      prevPar = null;
    } else {
      const labels = it.parallel.map(branchText);
      // branch centers spread around C
      const widths = labels.map(l => dw(l));
      const total = widths.reduce((s, w) => s + w, 0) + GAP * (labels.length - 1);
      let x = C - Math.floor(total / 2);
      const centers = widths.map(w => { const c = x + Math.floor(w / 2); x += w + GAP; return c; });
      if (prevPar && prevPar.length === centers.length) {
        putMulti(centers.map(c => ['↓', c]));
      } else {
        putMulti(centers.length === 2
          ? [['↙', centers[0]], ['↘', centers[1]]]
          : [['↙', centers[0]], ['↓', centers[1]], ['↘', centers[2]]]);
      }
      putMulti(labels.map((l, i) => [l, centers[i]]));
      labels.forEach(l => rowOf.set(l, lines.length - 1));
      prevPar = centers;
    }
  });

  // Loops: return channels down the right margin, one column band per loop.
  for (const loop of spec.loops ?? []) {
    for (const key of ['from', 'to']) {
      if (!rowOf.has(loop[key])) fail(`loop endpoint "${loop[key]}" not found in rendered flow`);
    }
    const fromRow = rowOf.get(loop.from), toRow = rowOf.get(loop.to);
    const top = Math.min(fromRow, toRow), bot = Math.max(fromRow, toRow);
    const col = Math.max(...lines.map(l => dw(l.trimEnd()))) + 2;
    for (let r = top; r <= bot; r++) {
      const base = lines[r].trimEnd();
      if (r === fromRow || r === toRow) {
        const head = r === toRow ? ' ←' : ' ';
        const fill = '─'.repeat(Math.max(col - dw(base) - head.length, 1));
        lines[r] = base + head + fill + (r === top ? '┐' : '┘');
      } else {
        lines[r] = padTo(base, col) + '│';
      }
    }
    if (loop.label) {
      const mid = Math.floor((top + bot) / 2);
      if (mid !== top && mid !== bot) lines[mid] += ' ' + loop.label;
      else lines[bot] += ' ' + loop.label;
    }
  }
  return lines.join('\n');
}

// ---------- entry ----------
function main() {
  const arg = process.argv[2];
  if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
  let src;
  if (!arg || arg === '-') src = readFileSync(0, 'utf8');
  else if (arg.trim().startsWith('{')) src = arg;
  else {
    try { src = readFileSync(arg, 'utf8'); }
    catch (e) { fail(`cannot read spec file "${arg}": ${e.message}`); }
  }

  let spec;
  try { spec = JSON.parse(src); }
  catch (e) { fail('invalid JSON: ' + e.message); }

  const dir = spec.dir ?? 'lr';
  if (!['lr', 'tb', 'tree'].includes(dir)) fail(`unknown "dir": "${dir}" (use lr, tb, or tree)`);
  if (!Array.isArray(spec.flow) || spec.flow.length === 0) fail('"flow" must be a non-empty array');
  validate(spec.flow, dir);
  for (const loop of spec.loops ?? []) {
    if (typeof loop?.from !== 'string' || typeof loop?.to !== 'string') fail('each loop needs string "from" and "to"');
    if (loop.from === loop.to) fail(`self-loop on "${loop.from}" is not supported; loops need two distinct nodes`);
    if (dir === 'tree') fail('"loops" are not supported in tree mode (use lr or tb)');
  }

  const out = dir === 'tb' ? renderTB(spec)
    : dir === 'tree' ? renderTree(spec)
    : renderLR(spec);
  const width = Math.max(...out.split('\n').map(l => dw(l)));
  if (dir === 'lr' && width > 110) {
    console.error(`arrow-diagram: ${width} columns wide — deep branch nesting reads better with "dir": "tree"`);
  }
  process.stdout.write(out.replace(/[ ]+$/gm, '') + '\n');
}

main();
