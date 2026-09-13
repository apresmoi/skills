import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseExercise, renderIntake } from "./exercise.mjs";

const cli = fileURLToPath(new URL("./exercise.mjs", import.meta.url));
const run = (home, ...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, DEEP_RESEARCH_HOME: home } });

test("built-in recipes parse and declare slots, site, mode, and a contract", () => {
  const dir = fileURLToPath(new URL("../recipes/research/", import.meta.url));
  for (const f of ["spread-timeline", "origin-attribution", "narrative-drift", "claim-check", "account-profile"]) {
    const ex = parseExercise(readFileSync(path.join(dir, `${f}.md`), "utf8"));
    assert.ok(ex.slots.length >= 1, f); assert.ok(ex.site && ex.mode, f);
    assert.ok(ex.sections.brief && ex.sections["output contract"] && ex.sections.verify, f);
    assert.match(ex.sections["output contract"], /=== REPORT COMPLETE ===/, f);
    for (const s of ex.slots) assert.ok(ex.sections.brief.includes(`{${s}}`), `${f}: slot ${s} unused in brief`);
  }
});

test("render fills every slot, refuses missing or unknown ones, and keeps the sentinel", () => {
  const ex = parseExercise("---\nname: t\nsite: grok\nmode: Expert\nslots: a, b\nversion: 2\n---\n## Brief\n\nLook at {a} during {b}.\n\n## Output contract\n\n- stuff\n\n## Verify\n\n- x\n");
  const out = renderIntake(ex, { a: "X", b: "May" }, "t");
  assert.match(out, /^# t — a: X · b: May \(v2, grok\/Expert\)/);
  assert.match(out, /Look at X during May\./); assert.match(out, /=== REPORT COMPLETE ===/); assert.match(out, /\n## Output\n$/);
  assert.throws(() => renderIntake(ex, { a: "X" }, "t"), /missing --set for: b/);
  assert.throws(() => renderIntake(ex, { a: "X", b: "May", c: "z" }, "t"), /unknown slot/);
});

test("cli: new from recipe, render into a run dir, log a verdict, list and runs", (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "dr-ex-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let r = run(home, "new", "spcx-stocks", "--from", "claim-check");
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(home, "exercises", "spcx-stocks.md");
  assert.ok(existsSync(file)); assert.match(readFileSync(file, "utf8"), /^name: spcx-stocks$/m); assert.match(readFileSync(file, "utf8"), /## Changelog/);
  r = run(home, "new", "spcx-stocks", "--from", "claim-check"); assert.equal(r.status, 2); assert.match(r.stderr, /already exists/);
  r = run(home, "new", "Bad Name", "--blank"); assert.equal(r.status, 2);
  r = run(home, "render", "spcx-stocks", "--set", "claim=SPCX will beat guidance", "--set", "context=Q3 2026");
  assert.equal(r.status, 0, r.stderr);
  const intake = r.stdout.trim(); assert.ok(existsSync(intake)); assert.match(readFileSync(intake, "utf8"), /SPCX will beat guidance/);
  assert.match(r.stderr, /run with: node run\.mjs --site chatgpt --model "Extra High"/);
  const ts = path.basename(path.dirname(intake));
  r = run(home, "log", "spcx-stocks", "--run", ts, "--verdict", "good"); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(home, "exercises", "spcx-stocks", "runs", ts, "run.json"), "utf8")).verdict, "good");
  r = run(home, "list"); assert.match(r.stdout, /spcx-stocks\s+v1\s+chatgpt\/Extra High.*runs: 1/);
  r = run(home, "runs", "spcx-stocks"); assert.match(r.stdout, /claim=SPCX will beat guidance.*good/);
  r = run(home, "render", "spcx-stocks", "--set", "claim=x"); assert.equal(r.status, 2); assert.match(r.stderr, /missing --set for: context/);
  r = run(home, "recipes"); assert.match(r.stdout, /spread-timeline\s+grok\/Expert/);
});
