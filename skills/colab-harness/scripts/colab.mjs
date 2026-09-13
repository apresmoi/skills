#!/usr/bin/env node
// colab-harness — drive a Colab runtime (running Colab_Harness.ipynb) from local.
// Session (tunnel URL + token) lives in ~/.colab-harness/session.json.
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const HOME = path.join(process.env.COLAB_HARNESS_HOME ?? path.join(homedir(), ".colab-harness"));
const SESSION = path.join(HOME, "session.json");
const TOKEN_FILE = path.join(HOME, "token");
const CHUNK = 8 * 1024 * 1024; // well under the tunnel's per-request cap

const USAGE = `colab-harness — use a Colab GPU runtime from here.

  node colab.mjs init                        generate the shared token once (store it as Colab secret HARNESS_TOKEN)
  node colab.mjs connect <url> [token]       save this session; token defaults to the one from init
  node colab.mjs status                      health: GPU, jobs, vLLM
  node colab.mjs run "<shell command>"       run a command on the VM (waits, prints output)
  node colab.mjs transcribe <audio> [--model large-v3] [--language es] [--compute-type float16] [--out DIR]
  node colab.mjs jobs                        list jobs
  node colab.mjs job <id>                    show one job
  node colab.mjs fetch <id> [--out DIR]      download a job's files
  node colab.mjs vllm start <model> [--max-model-len N]   start vLLM (installs on first use)
  node colab.mjs vllm status | stop
  node colab.mjs chat "<prompt>" [--model M] one non-streamed completion through the tunnel
  node colab.mjs env                         print OPENAI_BASE_URL / OPENAI_API_KEY for other clients
  node colab.mjs reload                      push the local harness_server.py to the VM and restart it

Exit 0 on success, 1 on a failed job or unreachable session, 2 on usage errors.`;

const die = (msg, code = 2) => { console.error(`colab-harness: ${msg}`); process.exit(code); };

const parse = (argv) => {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { opt[a.slice(2)] = argv[i + 1]; i++; }
    else pos.push(a);
  }
  return { pos, opt };
};

const loadSession = async () => {
  try { return JSON.parse(await readFile(SESSION, "utf8")); }
  catch { die(`no session; run the notebook and paste its connect line (looked in ${SESSION})`, 1); }
};

const api = async (session, method, route, { json, body, headers = {}, raw = false } = {}) => {
  const res = await fetch(session.url + route, {
    method, body: json !== undefined ? JSON.stringify(json) : body,
    headers: { authorization: `Bearer ${session.token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
  }).catch((e) => die(`cannot reach ${session.url}: ${e.cause?.code ?? e.message}. Is the notebook still running?`, 1));
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${data.detail ?? data.error ?? data.raw ?? text.slice(0, 200)}`, 1);
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitJob = async (session, id, { quiet = false } = {}) => {
  let last = "";
  for (;;) {
    const job = await api(session, "GET", `/jobs/${id}`);
    if (!quiet && job.status !== last) { console.error(`[${id}] ${job.status}`); last = job.status; }
    if (job.status === "done" || job.status === "failed") return job;
    await sleep(3000);
  }
};

const upload = async (session, file) => {
  const size = (await stat(file)).size;
  const { upload_id } = await api(session, "POST", "/uploads", { json: { filename: path.basename(file) } });
  let offset = 0;
  const stream = createReadStream(file, { highWaterMark: CHUNK });
  for await (const chunk of stream) {
    await api(session, "PUT", `/uploads/${upload_id}`, { body: chunk, headers: { "x-offset": String(offset), "content-type": "application/octet-stream" } });
    offset += chunk.length;
    process.stderr.write(`\rupload ${Math.round((offset / size) * 100)}% (${(offset / 1e6).toFixed(1)} / ${(size / 1e6).toFixed(1)} MB)`);
  }
  process.stderr.write("\n");
  return upload_id;
};

const submit = (session, kind, params) => {
  const form = new FormData();
  form.set("kind", kind);
  form.set("params", JSON.stringify(params));
  return api(session, "POST", "/jobs", { body: form });
};

const fetchFiles = async (session, job, outDir) => {
  await mkdir(outDir, { recursive: true });
  for (const name of job.files ?? []) {
    if (name.startsWith("input")) continue;
    const res = await api(session, "GET", `/jobs/${job.id}/files/${name}`, { raw: true });
    await writeFile(path.join(outDir, name), Buffer.from(await res.arrayBuffer()));
    console.error(`saved ${path.join(outDir, name)}`);
  }
};

const main = async () => {
  const { pos, opt } = parse(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(USAGE); return; }

  if (cmd === "init") {
    const { randomBytes } = await import("node:crypto");
    await mkdir(HOME, { recursive: true, mode: 0o700 });
    let exists = true;
    try { await stat(TOKEN_FILE); } catch { exists = false; }
    if (exists && !opt.force) { console.log(`token already exists at ${TOKEN_FILE} (use --force to rotate)`); return; }
    await writeFile(TOKEN_FILE, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
    console.log(`token written to ${TOKEN_FILE} (not printed).\nCopy it:   pbcopy < ${TOKEN_FILE}\nThen in Colab: 🔑 Secrets → add HARNESS_TOKEN, paste, enable notebook access.`);
    return;
  }

  if (cmd === "connect") {
    const [url, tokenArg] = rest;
    if (!url) die("usage: connect <url> [token]");
    let token = tokenArg;
    if (!token) {
      try { token = (await readFile(TOKEN_FILE, "utf8")).trim(); }
      catch { die("no token given and none stored; run: node colab.mjs init"); }
    }
    const session = { url: url.replace(/\/+$/, ""), token, connected_at: new Date().toISOString() };
    await mkdir(HOME, { recursive: true, mode: 0o700 });
    await writeFile(SESSION, JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
    const h = await api(session, "GET", "/health");
    console.log(`connected: ${session.url}\ngpu: ${h.gpu.name ?? h.gpu.error} · drive: ${h.drive_mounted ? "mounted" : "not mounted"} · uptime ${h.uptime_s}s`);
    return;
  }

  const session = await loadSession();

  if (cmd === "status") { console.log(JSON.stringify(await api(session, "GET", "/health"), null, 2)); return; }
  if (cmd === "env") { console.log(`export OPENAI_BASE_URL=${session.url}/v1\nexport OPENAI_API_KEY=${session.token}`); return; }
  if (cmd === "jobs") {
    for (const j of await api(session, "GET", "/jobs")) console.log(`${j.id}  ${j.kind.padEnd(10)} ${j.status.padEnd(7)} ${j.error ?? ""}`);
    return;
  }
  if (cmd === "job") { console.log(JSON.stringify(await api(session, "GET", `/jobs/${rest[0]}`), null, 2)); return; }
  if (cmd === "fetch") {
    const job = await api(session, "GET", `/jobs/${rest[0]}`);
    await fetchFiles(session, job, opt.out ?? path.join("colab-jobs", job.id));
    return;
  }

  if (cmd === "run") {
    const command = rest.join(" ");
    if (!command) die('usage: run "<shell command>"');
    const job = await submit(session, "shell", { cmd: command, timeout: Number(opt.timeout ?? 3600) });
    const done = await waitJob(session, job.id, { quiet: true });
    if (done.status === "failed") die(`job failed: ${done.error}`, 1);
    process.stdout.write(done.result.stdout_tail);
    if (done.result.stderr_tail) process.stderr.write(done.result.stderr_tail);
    process.exit(done.result.exit_code === 0 ? 0 : 1);
  }

  if (cmd === "transcribe") {
    const file = rest[0];
    if (!file) die("usage: transcribe <audio> [--model M] [--language xx] [--out DIR]");
    const uploadId = await upload(session, file);
    const params = { upload_id: uploadId, model: opt.model ?? "large-v3" };
    if (opt.language) params.language = opt.language;
    if (opt["compute-type"]) params.compute_type = opt["compute-type"];
    if (opt["word-timestamps"]) params.word_timestamps = true;
    const job = await submit(session, "transcribe", params);
    const done = await waitJob(session, job.id);
    if (done.status === "failed") die(`transcription failed: ${done.error}`, 1);
    const outDir = opt.out ?? path.join("colab-jobs", job.id);
    await fetchFiles(session, done, outDir);
    console.log(JSON.stringify({ id: job.id, ...done.result, out: outDir }, null, 2));
    return;
  }

  if (cmd === "vllm") {
    const [sub, model] = rest;
    if (sub === "status") { console.log(JSON.stringify(await api(session, "GET", "/vllm/status"), null, 2)); return; }
    if (sub === "stop") { console.log(JSON.stringify(await api(session, "POST", "/vllm/stop"))); return; }
    if (sub === "start") {
      if (!model) die("usage: vllm start <model>");
      const st0 = await api(session, "GET", "/vllm/status");
      if (!st0.installed) {
        console.error("vllm not installed on the VM; installing into its own venv (several minutes)…");
        const inst = await submit(session, "shell", { cmd: "python -m venv /content/vllm-venv && /content/vllm-venv/bin/pip install -q --upgrade pip && /content/vllm-venv/bin/pip install -q vllm", timeout: 2400 });
        const r = await waitJob(session, inst.id, { quiet: true });
        if (r.result?.exit_code !== 0) die(`vllm install failed:\n${r.result?.stderr_tail}`, 1);
      }
      const body = { model };
      if (opt["max-model-len"]) body.max_model_len = Number(opt["max-model-len"]);
      console.log(JSON.stringify(await api(session, "POST", "/vllm/start", { json: body })));
      console.error("waiting for vllm to load the model…");
      for (;;) {
        const st = await api(session, "GET", "/vllm/status");
        if (st.ready) { console.log("vllm ready:", st.model); return; }
        if (!st.running) die(`vllm exited (${st.exit_code}); log tail:\n${st.log_tail}`, 1);
        await sleep(5000);
      }
    }
    die("usage: vllm start <model> | status | stop");
  }

  if (cmd === "reload") {
    const src = await readFile(new URL("./harness_server.py", import.meta.url), "utf8");
    const b64 = Buffer.from(src).toString("base64");
    const script = `echo ${b64} | base64 -d > /content/harness_server.py && python -c "import ast; ast.parse(open('/content/harness_server.py').read())" && (sleep 1; pkill -f '[h]arness_server.py'; sleep 1; cd /content && setsid nohup python /content/harness_server.py > /content/harness_server.log 2>&1 &) && echo scheduled`;
    await submit(session, "shell", { cmd: script, timeout: 60 });
    console.error("restarting the VM server…");
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const res = await fetch(session.url + "/health", { headers: { authorization: `Bearer ${session.token}` } }).catch(() => null);
      if (res?.ok) { console.log("server reloaded; uptime", (await res.json()).uptime_s, "s"); return; }
    }
    die("server did not come back after reload; rerun cell 3 in the notebook", 1);
  }

  if (cmd === "chat") {
    const prompt = rest.join(" ");
    if (!prompt) die('usage: chat "<prompt>"');
    const st = await api(session, "GET", "/vllm/status");
    if (!st.ready) die("vllm is not ready; run: vllm start <model>", 1);
    const out = await api(session, "POST", "/v1/chat/completions", { json: { model: opt.model ?? st.model, messages: [{ role: "user", content: prompt }], max_tokens: Number(opt["max-tokens"] ?? 512) } });
    console.log(out.choices?.[0]?.message?.content ?? JSON.stringify(out));
    return;
  }

  die(`unknown command ${cmd}\n\n${USAGE}`);
};

main().catch((e) => die(e.message, 1));
