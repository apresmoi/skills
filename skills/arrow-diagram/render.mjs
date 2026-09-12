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

  node render.mjs --width 100 graph.json   # column budget (default 80)

Spec: { "dir": "auto"|"lr"|"tb"|"tree", "flow": [...], "loops": [...], "width": 80 }
  flow item : "label" | {"parallel":[alt,...]} | {"branch":[alt,...]}
  alt       : "label" | [nested flow]
  loop      : {"from":"label","to":"label","label":"text"}   (lr, tb)

Width: the diagram is planned to fit "width" columns (CLI --width wins,
default 80: what a chat code block or a narrow terminal shows without
wrapping). With no "dir", the first mode that fits is chosen: lr, a wrapped
chain (plain chains, no loops), tree (no loops), then tb (plain fans, no
branch). An explicit
"dir" is honoured but warns on stderr when it overflows.

Exit 0 on success, 2 on a spec error (message on stderr).`;

function fail(msg) { console.error('arrow-diagram: ' + msg); process.exit(2); }


// Labels must be printable single-line text: control characters, tabs, and
// newlines cannot be measured or aligned. Returns a problem string (soft) or
// fails outright (hard).
function checkText(text, what, soft = false) {
  let problem = null;
  if (text.trim() === '') problem = `${what} is empty`;
  else if (/[\u0000-\u001F\u007F]/.test(text)) problem = `${what} contains a control character (tab or newline)`;
  if (problem && !soft) fail(problem);
  return problem;
}

// Structural validation, independent of mode: item shapes, group sizes,
// branch position, and label text. Fails on the first problem.
function checkStructure(flow, path = 'flow') {
  flow.forEach((item, k) => {
    const where = `${path}[${k}]`;
    if (typeof item === 'string') return checkText(item, `node ${where}`);
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      fail(`${where} must be a string, {"parallel":[...]}, or {"branch":[...]}`);
    }
    const kinds = ['parallel', 'branch'].filter(key => key in item);
    if (kinds.length !== 1 || Object.keys(item).length !== 1) {
      fail(`${where} must be exactly one of {"parallel":[...]} or {"branch":[...]}`);
    }
    const kind = kinds[0];
    if (!Array.isArray(item[kind])) fail(`${where}: "${kind}" must be an array of alternatives`);
    if (kind === 'parallel' && item[kind].length === 0) fail(`${where}: "parallel" needs at least one alternative`);
    if (kind === 'branch' && item[kind].length < 2) fail(`${where}: "branch" needs at least two alternatives`);
    if (kind === 'branch' && k < flow.length - 1) fail(`${where}: "branch" must be the last item of its flow`);
    item[kind].forEach((alt, i) => {
      const sub = `${where}.${kind}[${i}]`;
      if (typeof alt === 'string') return checkText(alt, `node ${sub}`);
      if (!Array.isArray(alt)) fail(`${sub} must be a string or a nested flow array`);
      if (alt.length === 0) fail(`${sub} must be a non-empty flow`);
      checkStructure(alt, sub);
    });
  });
}

// Why a mode cannot draw this spec, or null if it can (structure is already valid).
function modeProblem(spec, mode) {
  let problem = null;
  const bad = msg => { if (!problem) problem = msg; };
  const hasLoops = (spec.loops ?? []).length > 0;
  const walk = (flow, depth) => flow.forEach((item, k) => {
    if (typeof item === 'string') return;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return bad(`flow item ${k} must be a string, {"parallel":[...]}, or {"branch":[...]}`);
    }
    const kind = 'parallel' in item ? 'parallel' : 'branch';
    if (kind === 'branch' && mode === 'tb') bad('"branch" is not supported in tb mode (use lr or tree)');
    if (mode === 'tb' && depth > 0) bad('tb mode does not support nested groups');
    if (mode === 'tb' && kind === 'parallel' && item.parallel.length > 3) bad('tb mode supports at most 3 parallel branches (use lr)');
    if (mode === 'wrap') bad('wrapped mode only draws a plain chain (no groups)');
    for (const alt of item[kind]) {
      if (typeof alt === 'string') continue;
      if (mode === 'tb') bad('tb mode alternatives must be plain labels (use lr for chains)');
      walk(alt, depth + 1);
    }
  });
  walk(spec.flow, 0);
  if (hasLoops && mode === 'tree') bad('"loops" are not supported in tree mode (use lr or tb)');
  if (hasLoops && mode === 'wrap') bad('wrapped mode does not draw loops (use tb)');
  return problem;
}

// ---------- WRAP ----------
// A plain chain too long for one row snakes onto the next rows:
//   a ─→ b ─→ c ─┐
//   ┌────────────┘
//   └─→ d ─→ e
function renderWrapped(spec, budget) {
  const labels = spec.flow.map(String);
  const rows = [];
  let cur = [];
  for (const label of labels) {
    const candidate = [...cur, label];
    const text = (rows.length ? '└─→ ' : '') + candidate.join(' ─→ ') + ' ─┐';
    if (cur.length && dw(text) > budget) { rows.push(cur); cur = [label]; }
    else cur = candidate;
  }
  rows.push(cur);
  const lines = [];
  rows.forEach((r, i) => {
    const last = i === rows.length - 1;
    const line = (i ? '└─→ ' : '') + r.join(' ─→ ') + (last ? '' : ' ─┐');
    lines.push(line);
    if (!last) lines.push('┌' + '─'.repeat(dw(line) - 2) + '┘');
  });
  return lines.join('\n');
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
    if (col !== x) return;                     // inside a wide glyph
    // A later channel running down through an earlier loop's arc row:
    //   ─ → ╫  crossing, no connection (┼ is reserved for fan junctions)
    //   └ → ├  and  ┘ → ┤  the arc's corner, when both loops share this column
    const through = { '─': '╫', '└': '├', '┘': '┤' };
    if (ch === '│' && through[cps[i]]) cps[i] = through[cps[i]];
    else if (cps[i] !== ' ') return;           // occupied by text: leave it
    else cps[i] = ch;
    lines[row] = cps.join('');
  };

  const loops = spec.loops ?? [];
  const at0 = label => built.nodes.find(n => n.label === label);
  const colOf = n => n ? n.x + Math.floor(dw(n.label) / 2) : -1;
  // Channels of loops drawn later run down through this loop's arc row, so
  // their columns are crossings on this arc; earlier loops stop above it.
  const crossingsAfter = i => new Set(loops.slice(i + 1).flatMap(l => [colOf(at0(l.from)), colOf(at0(l.to))]));

  for (const [li, loop] of loops.entries()) {
    const channelCols = crossingsAfter(li);
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
    const lw = dw(label);
    // A label must not sit on a column where another loop's channel crosses
    // this arc, or it would hide the ┼. Try centred, then slide within the
    // span; otherwise hang it to the right of the arc; otherwise drop below.
    const clear = (start, width) => {   // label cells plus one dash on each side
      for (let c = start - 1; c <= start + width; c++) if (c !== lo && c !== hi && channelCols.has(c)) return false;
      return true;
    };
    let fill = '─'.repeat(span);
    let placed = false;
    if (label && lw + 2 <= span) {
      const centre = lo + 1 + Math.floor((span - lw - 2) / 2);
      const candidates = [centre];
      for (let d = 1; d <= span; d++) candidates.push(centre - d, centre + d);
      for (const st of candidates) {
        if (st < lo + 1 || st + lw + 2 > hi) continue;
        if (!clear(st, lw + 2)) continue;
        fill = '─'.repeat(st - lo - 1) + ' ' + label + ' ' + '─'.repeat(hi - (st + lw + 2));
        placed = true;
        break;
      }
    }
    let arc = ' '.repeat(lo) + '└' + fill + '┘';
    if (label && !placed && clear(hi + 1, lw + 1)) { arc += ' ' + label; placed = true; }
    lines.push(arc);
    if (label && !placed) {
      const centre = Math.max(Math.floor((lo + hi) / 2) - Math.floor(lw / 2), 0);
      const limit = Math.max(...channelCols, hi) + lw + 2;
      let start = centre;
      for (let best = Infinity, c = 0; c <= limit; c++) {
        if (clear(c, lw) && Math.abs(c - centre) < best) { best = Math.abs(c - centre); start = c; }
      }
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
  const seen = new Map();  // label -> occurrences, to refuse ambiguous endpoints
  const fanPos = new Map(); // label -> 'rightmost' | 'inner' when inside a fan row
  const note = label => seen.set(label, (seen.get(label) ?? 0) + 1);
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
      rowOf.set(label, lines.length - 1); note(label);
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
      labels.forEach((l, i) => { rowOf.set(l, lines.length - 1); note(l); fanPos.set(l, i === labels.length - 1 ? 'rightmost' : 'inner'); });
      prevPar = centers;
    }
  });

  // Loops: return channels down the right margin, one column band per loop.
  for (const loop of spec.loops ?? []) {
    for (const key of ['from', 'to']) {
      const label = loop[key];
      if (!rowOf.has(label)) fail(`loop endpoint "${label}" is not a node label in the flow`);
      if (seen.get(label) > 1) fail(`loop endpoint "${label}" matches ${seen.get(label)} nodes; make the label unique`);
      if (fanPos.get(label) === 'inner') fail(`tb loops attach at the right margin, so "${label}" must be the rightmost label of its fan (or use lr)`);
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
  const argv = process.argv.slice(2);
  let cliWidth;
  const wi = argv.indexOf('--width');
  if (wi >= 0) {
    cliWidth = Number(argv[wi + 1]);
    if (!Number.isInteger(cliWidth) || cliWidth < 20) fail('--width must be an integer of at least 20');
    argv.splice(wi, 2);
  }
  const arg = argv[0];
  if (arg === '-h' || arg === '--help') { console.log(USAGE); process.exit(0); }
  for (const a of argv) if (a.startsWith('--')) fail(`unknown option ${a} (see --help)`);
  if (argv.length > 1) fail(`expected one spec (file, inline JSON, or stdin), got ${argv.length} arguments`);
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

  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) fail('spec must be a JSON object');
  const TOP = ['dir', 'flow', 'loops', 'width'];
  for (const key of Object.keys(spec)) if (!TOP.includes(key)) fail(`unknown key "${key}" (allowed: ${TOP.join(', ')})`);
  if (spec.dir !== undefined && typeof spec.dir !== 'string') fail('"dir" must be a string');
  const requested = (spec.dir ?? 'auto').toLowerCase();
  if (!['auto', 'lr', 'tb', 'tree'].includes(requested)) fail(`unknown "dir": "${spec.dir}" (use auto, lr, tb, or tree)`);
  if (!Array.isArray(spec.flow) || spec.flow.length === 0) fail('"flow" must be a non-empty array');
  checkStructure(spec.flow);
  const budget = cliWidth ?? spec.width ?? 80;
  if (!Number.isInteger(budget) || budget < 20) fail('"width" must be an integer of at least 20');
  if (spec.loops !== undefined && !Array.isArray(spec.loops)) fail('"loops" must be an array of {from, to, label}');
  const LOOP = ['from', 'to', 'label'];
  (spec.loops ?? []).forEach((loop, i) => {
    if (typeof loop !== 'object' || loop === null || Array.isArray(loop)) fail(`loop ${i} must be an object {from, to, label}`);
    for (const key of Object.keys(loop)) if (!LOOP.includes(key)) fail(`loop ${i}: unknown key "${key}" (allowed: ${LOOP.join(', ')})`);
    if (typeof loop.from !== 'string' || typeof loop.to !== 'string') fail(`loop ${i} needs string "from" and "to"`);
    if (loop.from === loop.to) fail(`self-loop on "${loop.from}" is not supported; loops need two distinct nodes`);
    if (loop.label !== undefined) {
      if (typeof loop.label === 'number') loop.label = String(loop.label);
      if (typeof loop.label !== 'string') fail(`loop ${i}: "label" must be a string`);
      checkText(loop.label, `loop ${i} label`);
    }
  });

  const widthOf = text => Math.max(...text.split('\n').map(l => dw(l)));
  const attempt = mode => {
    const problem = modeProblem(spec, mode);
    if (problem) return { mode, problem };
    const text = mode === 'tb' ? renderTB(spec) : mode === 'tree' ? renderTree(spec)
      : mode === 'wrap' ? renderWrapped(spec, budget) : renderLR(spec);
    return { mode, text, width: widthOf(text) };
  };

  let out;
  if (requested === 'auto') {
    // Narrowest readable mode that fits the budget, in order of preference.
    const tried = [];
    for (const mode of ['lr', 'wrap', 'tree', 'tb']) {
      const r = attempt(mode); tried.push(r);
      if (r.text && r.width <= budget) { out = r.text; break; }
    }
    if (!out) {
      const why = tried.map(r => `${r.mode}: ${r.problem ?? `${r.width} columns`}`).join('; ');
      fail(`no mode fits ${budget} columns (${why}). Shorten labels, raise "width", or split the diagram`);
    }
  } else {
    const r = attempt(requested);
    if (r.problem) fail(r.problem);
    out = r.text;
    if (r.width > budget) {
      const fits = ['lr', 'wrap', 'tree', 'tb'].filter(m => m !== requested)
        .map(attempt).filter(a => a.text && a.width <= budget).map(a => a.mode);
      console.error(`arrow-diagram: ${r.width} columns wide, over the ${budget}-column budget; it will wrap in a chat code block.`
        + (fits.length ? ` Fits in: ${fits.map(m => `"dir": "${m}"`).join(', ')}.` : ' No other mode fits; shorten labels or split the diagram.'));
    }
  }
  process.stdout.write(out.replace(/[ ]+$/gm, '') + '\n');
}

main();
