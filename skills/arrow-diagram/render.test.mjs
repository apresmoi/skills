import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const renderer = fileURLToPath(new URL("./render.mjs", import.meta.url));
const gallery = readFileSync(new URL("./GALLERY.md", import.meta.url), "utf8");

const render = (spec) => {
  const r = spawnSync(process.execPath, [renderer, typeof spec === "string" ? spec : JSON.stringify(spec)], { encoding: "utf8" });
  return { out: r.stdout, err: r.stderr, code: r.status };
};
const ok = (spec) => { const r = render(spec); assert.equal(r.code, 0, r.err); return r.out.replace(/\n$/, ""); };
const bad = (spec, re) => { const r = render(spec); assert.equal(r.code, 2, r.out); assert.match(r.err, re); };

// Every JSON block in GALLERY.md followed by a plain block is a golden pair.
const blocks = [...gallery.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((m) => [m[1], m[2]]);
let pairs = 0;
for (let i = 0; i + 1 < blocks.length; i++) {
  if (blocks[i][0] !== "json" || blocks[i + 1][0] !== "") continue;
  const [spec, expected] = [blocks[i][1], blocks[i + 1][1]];
  pairs++;
  test(`gallery #${pairs} reproduces byte-for-byte`, () => {
    assert.equal(ok(spec), expected.replace(/\n$/, ""));
  });
}
test("gallery has golden pairs", () => assert.ok(pairs >= 10, `found ${pairs}`));

test("groups nest inside parallel alternatives", () => {
  assert.equal(ok({ flow: ["a", { parallel: ["x", ["y", { parallel: ["p", "q"] }]] }, "b"] }), [
    "    ┌─→ x ────────────┐",
    "a ──┤                 ├─→ b",
    "    │       ┌─→ p ─┐  │",
    "    └─→ y ──┤      ├──┘",
    "            └─→ q ─┘",
  ].join("\n"));
  assert.equal(ok({ flow: ["a", { parallel: ["x", ["y", { branch: ["p", "q"] }]] }, "b"] }), [
    "    ┌─→ x ─────────┐",
    "a ──┤              ├─→ b",
    "    └─→ y ──┬─→ p ─┘",
    "            └─→ q",
  ].join("\n"));
});

test("odd fan keeps the trunk through a multi-row middle alternative", () => {
  assert.equal(ok({ flow: ["a", { parallel: ["x", ["y", { parallel: ["p", "q", "r"] }], "z"] }, "b"] }), [
    "    ┌─→ x ────────────┐",
    "    │       ┌─→ p ─┐  │",
    "a ──┼─→ y ──┼─→ q ─┼──┼─→ b",
    "    │       └─→ r ─┘  │",
    "    └─→ z ────────────┘",
  ].join("\n"));
});

test("loop endpoints match whole node labels, never substrings", () => {
  assert.equal(ok({ flow: ["coding agent", "tests", "agent"], loops: [{ from: "tests", to: "agent", label: "retry" }] }), [
    "coding agent ─→ tests ─→ agent",
    "                  │        ↑",
    "                  └ retry ─┘",
  ].join("\n"));
  assert.equal(ok({ flow: ["replan", "go", "plan"], loops: [{ from: "go", to: "plan" }] }), [
    "replan ─→ go ─→ plan",
    "           │      ↑",
    "           └──────┘",
  ].join("\n"));
});

test("loop endpoints may contain spaces", () => {
  assert.equal(ok({ flow: ["coding agent", "run tests", "merge"], loops: [{ from: "run tests", to: "coding agent", label: "fail" }] }), [
    "coding agent ─→ run tests ─→ merge",
    "      ↑             │",
    "      └─── fail ────┘",
  ].join("\n"));
});

test("forward loops close upward like back-edges", () => {
  assert.equal(ok({ flow: ["a", "b", "c"], loops: [{ from: "a", to: "c", label: "skip" }] }), [
    "a ─→ b ─→ c",
    "│         ↑",
    "└─ skip ──┘",
  ].join("\n"));
});

test("wide characters keep rails and arcs aligned", () => {
  assert.equal(ok({ flow: ["a", { parallel: ["日本語ノード", "🚀 launch", "plain"] }, "b"], loops: [{ from: "b", to: "a", label: "again" }] }), [
    "    ┌─→ 日本語ノード ─┐",
    "a ──┼─→ 🚀 launch ────┼─→ b",
    "↑   └─→ plain ────────┘   │",
    "│                         │",
    "└───────── again ─────────┘",
  ].join("\n"));
  assert.equal(ok({ dir: "tb", flow: ["入口", { parallel: ["甲", "🚀", "乙"] }, "verdict"] }), [
    "    入口",
    " ↙    ↓    ↘",
    "甲   🚀   乙",
    " ↘    ↓    ↙",
    "   verdict",
  ].join("\n"));
});

test("narrow symbols are not treated as wide", () => {
  assert.equal(ok({ flow: ["a", { branch: ["done ✓", "↘ later"] }] }), [
    "a ──┬─→ done ✓",
    "    └─→ ↘ later",
  ].join("\n"));
});

test("spec errors exit 2 with a named reason", () => {
  bad({ dir: "xx", flow: ["a"] }, /unknown "dir"/);
  bad({ flow: [] }, /non-empty/);
  bad({ flow: ["a", 42] }, /flow item 1/);
  bad({ flow: ["a", { branch: ["x"] }, "b"] }, /must be the last item/);
  bad({ dir: "tb", flow: ["a", { branch: ["x", "y"] }] }, /not supported in tb/);
  bad({ dir: "tb", flow: ["a", { parallel: ["x", ["y", "z"]] }] }, /plain labels/);
  bad({ dir: "tree", flow: ["a", { branch: ["x", "y"] }], loops: [{ from: "x", to: "a" }] }, /not supported in tree/);
  bad({ flow: ["a", "b"], loops: [{ from: "b", to: "b" }] }, /self-loop/);
  bad({ flow: ["a", "b"], loops: [{ from: "b", to: "zzz" }] }, /not a node label/);
  bad({ flow: ["a", "eval", "b", "eval"], loops: [{ from: "b", to: "eval" }] }, /matches 2 nodes/);
  bad("{not json", /invalid JSON/);
});

test("--help prints usage and exits 0", () => {
  const r = spawnSync(process.execPath, [renderer, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /arrow-diagram/);
});
