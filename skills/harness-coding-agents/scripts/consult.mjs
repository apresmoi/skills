#!/usr/bin/env node

// Harness the locally installed subscription coding CLIs (agy, grok, codex) as
// bounded external agents. Consultation is the default; --write is an explicit
// escalation. No shell is used; stdout/stderr are captured per engine.

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const KNOWN_ENGINES = ["agy", "grok", "codex"];

const usage = `Usage:
  node consult.mjs [options]

Required:
  --prompt <text> | --prompt-file <path>

Options:
  --engine <list>           Consultant(s): comma list of agy,grok,codex,
                            or "both" (agy,grok) or "all" (agy,grok,codex).
                            Default: both
  --cwd <path>              Project directory; default: current directory
  --out-dir <path>          Report directory; default: a new directory under /tmp
  --write                   Permit file edits (one engine only)
  --agy-model <name>        Override the configured AGY model
  --grok-model <name>       Override the configured Grok model
  --codex-model <name>      Override the configured Codex model
  --max-turns <n>           Grok turn limit; default: 24
  --timeout <duration>      Print/process timeout; default: 300s
  --check                   Preflight only: report binary + login presence per
                            engine and exit (no prompt needed)
  -h, --help                Show this help

All three drive SUBSCRIPTION logins (agy: Antigravity OAuth; grok: ~/.grok;
codex: ~/.codex/auth.json). Never print or copy credential contents. Each
engine's stdout/stderr lands in <out-dir>/<engine>.md and <engine>.stderr.txt;
a nonzero exit means at least one consultant failed preflight, failed, or
timed out. Preflight runs before every launch: an engine whose binary is not
on PATH or whose login record is absent is reported and NOT launched.`;

const parseDurationMs = (value) => {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  if (!match) throw new Error(`Invalid duration "${value}" (use ms, s, m, or h)`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return Number(match[1]) * factors[match[2]];
};

const resolveEngines = (value) => {
  const raw = value.trim().toLowerCase();
  if (raw === "both") return ["agy", "grok"];
  if (raw === "all") return ["agy", "grok", "codex"];
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const seen = [];
  for (const engine of list) {
    if (!KNOWN_ENGINES.includes(engine)) {
      throw new Error(`Unknown engine "${engine}" (use agy, grok, codex, both, or all)`);
    }
    if (!seen.includes(engine)) seen.push(engine);
  }
  if (seen.length === 0) throw new Error("--engine resolved to no engines");
  return seen;
};

const parseArgs = (argv) => {
  const options = {
    cwd: process.cwd(),
    engine: "both",
    maxTurns: "24",
    timeout: "300s",
    write: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[index];
    };
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--engine") options.engine = next();
    else if (arg === "--cwd") options.cwd = path.resolve(next());
    else if (arg === "--out-dir") options.outDir = path.resolve(next());
    else if (arg === "--prompt") options.prompt = next();
    else if (arg === "--prompt-file") options.promptFile = path.resolve(next());
    else if (arg === "--write") options.write = true;
    else if (arg === "--check") options.check = true;
    else if (arg === "--agy-model") options.agyModel = next();
    else if (arg === "--grok-model") options.grokModel = next();
    else if (arg === "--codex-model") options.codexModel = next();
    else if (arg === "--max-turns") options.maxTurns = next();
    else if (arg === "--timeout") options.timeout = next();
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
};

const stripAnsi = (text) =>
  text.replace(/(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();

const run = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      stderr.push(Buffer.from(error.message));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        signal,
        stderr: stripAnsi(Buffer.concat(stderr).toString("utf8")),
        stdout: stripAnsi(Buffer.concat(stdout).toString("utf8")),
        timedOut
      });
    });
  });


// ---------------------------------------------------------------------------
// Preflight: binary on PATH + login record present. Checks presence and mtime
// only; never reads or prints credential contents.
// ---------------------------------------------------------------------------

const home = homedir();
const LOGIN_RECORDS = {
  agy: () => ({
    dir: process.env.ANTIGRAVITY_CLI_HOME ?? path.join(home, ".gemini", "antigravity-cli"),
    file: "antigravity-oauth-token",
    login: "agy login"
  }),
  grok: () => ({
    dir: process.env.GROK_HOME ?? path.join(home, ".grok"),
    file: "auth.json",
    login: "grok login"
  }),
  codex: () => ({
    dir: process.env.CODEX_HOME ?? path.join(home, ".codex"),
    file: "auth.json",
    login: "codex login"
  })
};

const findOnPath = async (command) => {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
};

const preflightEngine = async (engine) => {
  const binary = await findOnPath(engine);
  const record = LOGIN_RECORDS[engine]();
  const loginPath = path.join(record.dir, record.file);
  let loginMtime = null;
  try {
    loginMtime = (await stat(loginPath)).mtime.toISOString();
  } catch {
    loginMtime = null;
  }
  const problems = [];
  if (!binary) problems.push(`executable "${engine}" not found on PATH`);
  if (!loginMtime) problems.push(`login record missing (${loginPath}); run \`${record.login}\``);
  return {
    engine,
    ok: problems.length === 0,
    binary,
    login_record: loginPath,
    login_record_mtime: loginMtime,
    problems
  };
};

const formatPreflight = (entry) => {
  const status = entry.ok ? "ok  " : "FAIL";
  const detail = entry.ok
    ? `${entry.binary}; login record ${entry.login_record_mtime}`
    : entry.problems.join("; ");
  return `[preflight] ${status} ${entry.engine.padEnd(5)} ${detail}`;
};

const buildPrompt = (prompt, write) => [
  write
    ? "You are an external implementation agent. Modify only the requested scope."
    : "You are an independent read-only consultant. Do not modify files.",
  "Inspect the supplied project directly when useful.",
  "Separate verified evidence from inference. Cite repository paths and line numbers.",
  "Return: verdict; findings ordered by severity; uncertainties; verification commands.",
  "",
  "TASK",
  prompt
].join("\n");

const buildArgs = async (engine, { prompt, options, outDir }) => {
  if (engine === "agy") {
    const args = [
      "--print",
      prompt,
      "--print-timeout",
      options.timeout,
      "--new-project",
      "--add-dir",
      options.cwd
    ];
    if (options.write) args.push("--mode", "accept-edits", "--dangerously-skip-permissions");
    else args.push("--mode", "plan", "--sandbox");
    if (options.agyModel) args.push("--model", options.agyModel);
    return { command: "agy", args };
  }

  if (engine === "grok") {
    const promptPath = path.join(outDir, ".grok-prompt.md");
    await writeFile(promptPath, prompt, { mode: 0o600 });
    const args = [
      "--prompt-file",
      promptPath,
      "--cwd",
      options.cwd,
      "--max-turns",
      options.maxTurns,
      "--no-memory",
      "--disable-web-search",
      "--no-subagents",
      "--output-format",
      "plain",
      "--permission-mode",
      options.write ? "auto" : "plan"
    ];
    if (options.write) args.push("--always-approve");
    if (options.grokModel) args.push("--model", options.grokModel);
    return { command: "grok", args, promptPath };
  }

  // codex — non-interactive `codex exec`. Sandbox is the safety boundary:
  // read-only for consultation, workspace-write for authorized edits. The
  // approval_policy override keeps exec fully non-interactive.
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    options.cwd,
    "--sandbox",
    options.write ? "workspace-write" : "read-only",
    "-c",
    'approval_policy="never"'
  ];
  // Codex has native cross-session memories (config `[features] memories`,
  // `generate_memories` / `use_memories`), read AND written by every run. In
  // consultation the contract's "disable ambient cross-session memory" rule
  // applies, same as Grok's --no-memory: otherwise a review inherits the
  // conclusions an earlier implementation run deposited, and independence is
  // lost silently. `--disable memories` == `-c features.memories=false`.
  if (!options.write) args.push("--disable", "memories");
  if (options.codexModel) args.push("-m", options.codexModel);
  args.push(prompt);
  return { command: "codex", args };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const engines = resolveEngines(options.engine);

  const preflight = await Promise.all(engines.map(preflightEngine));
  for (const entry of preflight) process.stderr.write(`${formatPreflight(entry)}\n`);
  const ready = preflight.filter((entry) => entry.ok).map((entry) => entry.engine);

  if (options.check) {
    process.stdout.write(`${JSON.stringify({ preflight }, null, 2)}\n`);
    if (ready.length !== engines.length) process.exitCode = 1;
    return;
  }
  if (ready.length === 0) {
    throw new Error("preflight failed for every requested engine; nothing launched");
  }
  if (ready.length !== engines.length) {
    const skipped = engines.filter((engine) => !ready.includes(engine)).join(", ");
    process.stderr.write(`harness-coding-agents: skipping ${skipped} (preflight failed); not substituting another engine\n`);
  }

  if (options.write && engines.length !== 1) {
    throw new Error("Write mode requires exactly one engine; use separate worktrees for parallel writers");
  }
  if (Boolean(options.prompt) === Boolean(options.promptFile)) {
    throw new Error("Provide exactly one of --prompt or --prompt-file");
  }
  if (!/^[1-9]\d*$/.test(options.maxTurns)) {
    throw new Error("--max-turns must be a positive integer");
  }

  const timeoutMs = parseDurationMs(options.timeout);
  const rawPrompt = options.prompt ?? await readFile(options.promptFile, "utf8");
  const prompt = buildPrompt(rawPrompt.trim(), options.write);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = options.outDir ?? path.join(tmpdir(), `harness-coding-agents-${stamp}`);
  await mkdir(outDir, { recursive: true });

  const jobs = ready.map(async (engine) => {
    const { command, args, promptPath } = await buildArgs(engine, { prompt, options, outDir });
    const result = await run(command, args, { cwd: options.cwd, timeoutMs });
    if (promptPath) await rm(promptPath, { force: true });
    await Promise.all([
      writeFile(path.join(outDir, `${engine}.md`), `${result.stdout}\n`),
      writeFile(path.join(outDir, `${engine}.stderr.txt`), `${result.stderr}\n`)
    ]);
    return { engine, ...result };
  });

  const results = await Promise.all(jobs);
  const summary = {
    cwd: options.cwd,
    mode: options.write ? "write" : "consult",
    out_dir: outDir,
    preflight,
    results: results.map(({ engine, code, signal, timedOut }) => ({
      engine,
      exit_code: code,
      signal,
      timed_out: timedOut
    }))
  };
  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (ready.length !== engines.length || results.some((result) => result.code !== 0 || result.timedOut)) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  process.stderr.write(`harness-coding-agents: ${error.message}\n`);
  process.exitCode = 1;
});
