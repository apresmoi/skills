import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the executable boundary without spending subscription requests.
// Real CLI file reads/writes are also checked before delivering engine changes.
const runner = fileURLToPath(new URL("./consult.mjs", import.meta.url));
const sentinel = "=== REPORT COMPLETE ===";
const fakeClaude = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const auth = args.includes('auth');
appendFileSync(process.env.HARNESS_TEST_LOG, JSON.stringify({
  args, cwd: process.cwd(),
  overrides: Object.keys(process.env).filter(k => /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|ANTHROPIC_PROFILE|ANTHROPIC_FEDERATION_RULE_ID|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDECODE|CLAUDE_CODE_SIMPLE)$/.test(k)),
  configDir: process.env.CLAUDE_CONFIG_DIR,
  modelDefault: process.env.ANTHROPIC_MODEL
}) + '\\n');
if (auth) {
  const variant = process.env.HARNESS_TEST_AUTH;
  if (variant === 'malformed') { console.log('private-account-marker'); process.exit(0); }
  console.log(JSON.stringify({loggedIn: variant !== 'missing', authMethod: variant === 'api' ? 'api_key' : 'claude.ai', apiProvider: variant === 'provider' ? 'bedrock' : 'firstParty', email: 'private-account-marker'}));
  process.exit(variant === 'failed' ? 1 : 0);
}
const variant = process.env.HARNESS_TEST_RESULT;
if (variant === 'timeout') { setInterval(() => {}, 1000); }
else if (variant === 'malformed') { console.log('not JSON'); }
else {
  const result = variant === 'empty' ? '' : variant === 'sentinel-only' ? '${sentinel}' : variant === 'incomplete' ? 'Opening sentence.' : 'Verified report.\\n${sentinel}';
  console.log(JSON.stringify({type: 'result', subtype: variant === 'limited' ? 'error_max_turns' : 'success', is_error: variant === 'error', result}));
  if (variant === 'exit-failed') process.exitCode = 7;
}
`;

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-claude-test-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(path.join(bin, "claude"), fakeClaude, { mode: 0o700 });
  const log = path.join(dir, "calls.jsonl");
  const out = path.join(dir, "reports");
  const env = { ...process.env, PATH: bin, HARNESS_TEST_LOG: log };
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir, out, env,
    invoke(args = [], overrides = {}) {
      return spawnSync(process.execPath, [runner, "--engine", "claude", "--cwd", dir, "--out-dir", out, ...args], {
        cwd: dir, env: { ...env, ...overrides }, encoding: "utf8", timeout: 25_000
      });
    },
    calls() { try { return readFileSync(log, "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } },
    read(name) { return readFileSync(path.join(out, name), "utf8"); }
  };
}

test("subscription preflight discards account fields and does not start a task", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--check"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).preflight[0].ok, true);
  assert.equal(f.calls().length, 1);
  assert.ok(!result.stdout.includes("private-account-marker"));
  assert.ok(!result.stderr.includes("private-account-marker"));
});

for (const variant of ["missing", "api", "provider", "malformed", "failed"]) {
  test(`preflight rejects ${variant} auth without exposing status or launching a task`, (t) => {
    const f = fixture(t);
    const result = f.invoke(["--prompt", "Review"], { HARNESS_TEST_AUTH: variant });
    assert.equal(result.status, 1);
    assert.equal(f.calls().length, 1);
    assert.ok(!result.stdout.includes("private-account-marker"));
    assert.ok(!result.stderr.includes("private-account-marker"));
  });
}

test("missing executable is reported without substitution", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.env.PATH, "claude"));
  const result = f.invoke(["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not found on PATH/);
  assert.deepEqual(f.calls(), []);
});

test("default consultation is read-only, isolated, and extracts a complete report", (t) => {
  const f = fixture(t);
  const overrides = Object.fromEntries([
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDECODE", "CLAUDE_CODE_SIMPLE"
  ].map((key) => [key, "test-override"]));
  overrides.CLAUDE_CONFIG_DIR = path.join(f.dir, "claude-config");
  overrides.ANTHROPIC_MODEL = "configured-model-for-test";
  const result = f.invoke(["--prompt", "Read source"], overrides);
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.overrides, []);
    assert.equal(call.configDir, overrides.CLAUDE_CONFIG_DIR);
    assert.equal(call.modelDefault, overrides.ANTHROPIC_MODEL);
    assert.equal(realpathSync(call.cwd), realpathSync(f.dir));
    assert.ok(call.args.includes("--safe-mode"));
    assert.ok(call.args.includes("--restricted"));
    assert.ok(!call.args.includes("--bare"));
  }
  const args = calls[1].args;
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "Read,Glob,Grep");
  assert.equal(value("--allowedTools"), "Read,Glob,Grep");
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(value("--permission-prompts"), "none");
  assert.equal(value("--max-turns"), "24");
  assert.equal(value("--output-format"), "json");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(value("--mcp-config")), { mcpServers: {} });
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(!args.includes("--model"));
  assert.ok(args.at(-1).includes(sentinel));
  assert.equal(f.read("claude.md"), `Verified report.\n${sentinel}\n`);
  assert.equal(JSON.parse(f.read("claude.result.json")).subtype, "success");
  assert.equal(JSON.parse(f.read("summary.json")).results[0].exit_code, 0);
});

test("write mode adds editing and shell tools and forwards model/turn overrides", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--write", "--prompt", "Edit one file", "--claude-model", "model-for-test", "--max-turns", "7"]);
  assert.equal(result.status, 0, result.stderr);
  const args = f.calls()[1].args;
  assert.equal(args[args.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write,Bash");
  assert.equal(args[args.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Edit,Write,Bash");
  assert.equal(args[args.indexOf("--model") + 1], "model-for-test");
  assert.equal(args[args.indexOf("--max-turns") + 1], "7");
  assert.equal(JSON.parse(f.read("summary.json")).mode, "write");
});

test("all includes Claude; both and the default preserve the existing pair", (t) => {
  const f = fixture(t);
  const all = f.invoke(["--engine", "all", "--check"]);
  assert.deepEqual(JSON.parse(all.stdout).preflight.map((e) => e.engine), ["agy", "grok", "codex", "claude"]);
  const both = f.invoke(["--engine", "both", "--check"]);
  assert.deepEqual(JSON.parse(both.stdout).preflight.map((e) => e.engine), ["agy", "grok"]);
  const defaults = spawnSync(process.execPath, [runner, "--check"], { env: f.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(defaults.stdout).preflight.map((e) => e.engine), ["agy", "grok"]);
});

test("mixed-engine writes fail before any CLI launches, even with --check", (t) => {
  const f = fixture(t);
  const result = f.invoke(["--engine", "claude,codex", "--write", "--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one engine/);
  assert.deepEqual(f.calls(), []);
});

test("invalid task arguments fail before any authentication subprocess", (t) => {
  const f = fixture(t);
  for (const args of [[], ["--prompt", "Review", "--prompt-file", "also.md"],
    ["--prompt", "Review", "--max-turns", "0"], ["--prompt", "Review", "--timeout", "invalid"]]) {
    const result = f.invoke(args);
    assert.equal(result.status, 1);
  }
  assert.deepEqual(f.calls(), []);
});

test("comma lists deduplicate Claude and accept prompt files", (t) => {
  const f = fixture(t);
  const promptFile = path.join(f.dir, "prompt.md");
  writeFileSync(promptFile, "Read the bounded evidence.");
  const result = f.invoke(["--engine", "claude,claude", "--prompt-file", promptFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls()[1].args.at(-1).includes("Read the bounded evidence."));
});

for (const variant of ["empty", "sentinel-only", "incomplete", "malformed", "error", "limited", "exit-failed", "timeout"]) {
  test(`reports ${variant} completion as failure`, (t) => {
    const f = fixture(t);
    const result = f.invoke(["--prompt", "Review", "--timeout", "500ms"], { HARNESS_TEST_RESULT: variant });
    assert.equal(result.status, 1, result.stderr);
    const summary = JSON.parse(f.read("summary.json"));
    assert.notEqual(summary.results[0].exit_code, 0);
    assert.equal(summary.results[0].timed_out, variant === "timeout");
    if (variant !== "exit-failed") assert.match(f.read("claude.stderr.txt"), /incomplete report/);
  });
}
