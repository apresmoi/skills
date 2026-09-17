#!/usr/bin/env node
// colab-harness — drive a Colab runtime (running Colab_Harness.ipynb) from local.
// Session (tunnel URL + token) lives in ~/.colab-harness/session.json.
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile, execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOME = path.join(process.env.COLAB_HARNESS_HOME ?? path.join(homedir(), ".colab-harness"));
const TOKEN_FILE = path.join(HOME, "token");
const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const require_cp = () => ({ execFile, spawn });
const YT_COOKIES = path.join(HOME, "youtube-cookies.txt");   // seeded by the user, never read by an agent
// Sessions are named so several runtimes can be driven at once:
//   --session train   or   COLAB_SESSION=train   (default: "default")
const SESSIONS_DIR = path.join(HOME, "sessions");
const sessionFile = (name) => path.join(SESSIONS_DIR, `${name}.json`);
const CHUNK = 8 * 1024 * 1024; // well under the tunnel's per-request cap

const USAGE = `colab-harness — use a Colab GPU runtime from here.

  node colab.mjs init                        generate the shared token once (store it as Colab secret HARNESS_TOKEN)
  node colab.mjs check                       START HERE: every prerequisite as OK/WARN/MISSING with its fix, runtimes up,
                                             and the next command. Exit 0 ready, 1 no runtime, 2 setup incomplete.
  node colab.mjs start [--via playwright|chrome] [--gpu L4] [--headed]
                                             start a runtime with no human: playwright drives a dedicated Google-signed-in
                                             Chrome profile headless; chrome means the agent drives the Claude extension
  node colab.mjs config [set starter playwright|chrome | set gpu L4 | show]   preferences (~/.colab-harness/config.json)
  node colab.mjs auth                        the onboarding message: how to export Google cookies for the playwright starter
  node colab.mjs auth install [file]         file the export (default: newest google/colab *cookies*.txt in ~/Downloads)
                                             into ~/.colab-harness/google-cookies.txt and seed the profile; prints counts only
  node colab.mjs auth status | remove        is the profile signed in (account label only) / delete cookies + profile
  node colab.mjs connect [url] [token]       save this session; with no url, finds the runtime the notebook
                                             published to Hugging Face (<user>/colab-harness-state, private)
  node colab.mjs sessions                    list saved sessions and whether each still answers
  --session <name>                           act on a named session (default "default"; env COLAB_SESSION)
                                             one runtime per session: e.g. --session train and --session serve
  node colab.mjs status                      health: GPU, jobs, vLLM
  node colab.mjs run "<shell command>"       run a command on the VM (waits, prints output)
  node colab.mjs transcribe <audio | --from-job ID> [--model large-v3] [--language es] [--diarization JOB] [--out DIR]
  node colab.mjs youtube <url> [--cookies PATH] [--no-cookies] [--fetch-audio] [--out DIR]
                                             download audio (mono 16 kHz wav) on the VM; cookies default to
                                             ~/.colab-harness/youtube-cookies.txt when that file exists
  node colab.mjs cookies install [file]      move a Netscape cookies.txt export into place (default: newest
                                             *youtube*cookies*.txt in ~/Downloads); prints counts only, never values
  node colab.mjs cookies status | remove     is a cookie file present, how many cookies, earliest expiry / delete it
  node colab.mjs diarize <audio | --from-job ID> [--speakers N] [--out DIR]   pyannote 3.1 (needs HF_TOKEN secret + accepted terms)
  node colab.mjs pipeline <url|audio> [--language es] [--speakers N] [--out DIR]
                                             youtube (if url) → diarize → transcribe with speakers, one command
  node colab.mjs script <file.py|.sh> [--args "a b"] [--env K=V,K2=V2] [--python PATH] [--out DIR] [--push REPO [--push-dir adapter] [--public]]
             [--supervise [--resume-env K=V] [--poll 20] [--keep-every 10] [--minutes 60] [--misses 3] [--restarts 3]]
                                             upload and run a script on the VM (train, DSPy compile, ...);
                                             --supervise survives a lost runtime: renews the lease, restarts the runtime
                                             and resubmits with --resume-env so a checkpointing script continues;
                                             --push uploads a folder to a PRIVATE Hugging Face repo when it succeeds
  node colab.mjs hf                          Hugging Face token on the VM: user, role, can it push
  --name N --description "..." --tags a,b    with script: catalog the trained model (name defaults to the push repo)
  node colab.mjs models [list] [--owner X] [--base X] [--json]   the catalog of trained models (~/.colab-harness/catalog.json)
  node colab.mjs models search <query>       substring match over name, description, tags, base, dataset, owner, args
  node colab.mjs models show <name>          full entry
  node colab.mjs models edit <name> [--description "..."] [--tags a,b] [--name new]
  node colab.mjs models sync                 add hub repos tagged colab-harness that the catalog lacks (needs a local HF login)
  node colab.mjs keep [--minutes 120] [--dry-run]   extend the lease; prints the compute-unit cost of that time
  node colab.mjs cost                        this month's sessions, units, % of the monthly allowance, balance if seeded
  node colab.mjs budget set --monthly 100 --available <n>   seed the allowance and the balance from Colab's Resources panel
  node colab.mjs budget rate --gpu "<name>" --units-per-hour N   record a measured rate for a GPU
  node colab.mjs release                     stop vLLM and unassign the runtime (the kill switch)
  node colab.mjs jobs                        list jobs
  node colab.mjs job <id>                    show one job
  node colab.mjs fetch <id> [--out DIR] [--all]   download a job's files (--all includes trainer checkpoints)
  node colab.mjs vllm start <model> [--max-model-len N] [--vllm-args "..."]   start vLLM (installs on first use)
  node colab.mjs vllm status | stop
  node colab.mjs chat "<prompt>" [--model M] one non-streamed completion through the tunnel
  node colab.mjs progress                    one line per running job across all sessions, with a bar when the log shows n/m or n%
  node colab.mjs ui [--no-open]              open the tiny dashboard served by the VM (jobs, live logs, lease)
  --follow                                   with run/script/transcribe/diarize/youtube/pipeline: stream the job's log while waiting
  node colab.mjs env                         print OPENAI_BASE_URL / OPENAI_API_KEY for other clients
  node colab.mjs reload                      push the local harness_server.py to the VM and restart it

Exit 0 on success, 1 on a failed job or unreachable session, 2 on usage errors.`;

const die = (msg, code = 2) => { console.error(`colab-harness: ${msg}`); process.exit(code); };

const parse = (argv) => {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const n = argv[i + 1]; if (["args", "vllm-args"].includes(a.slice(2)) && n !== undefined) { opt[a.slice(2)] = n; i++; continue; } if (["follow", "no-open", "all", "no-cookies", "fetch-audio", "word-timestamps", "force", "dry-run", "public", "json", "no-seed"].includes(a.slice(2)) || n === undefined || n.startsWith("--")) opt[a.slice(2)] = true; else { opt[a.slice(2)] = n; i++; } }
    else pos.push(a);
  }
  return { pos, opt };
};

// Compute-unit rates per hour by GPU name. Only the L4 figure is measured (Colab
// Resources panel, Pro plan, 2026-09-13); the others are estimates until measured.
// Override or add with: node colab.mjs budget rate --gpu "Tesla T4" --units-per-hour 1.44
const DEFAULT_RATES = { "NVIDIA L4": { rate: 1.54, measured: true }, "Tesla T4": { rate: 1.44, measured: false }, "NVIDIA A100-SXM4-40GB": { rate: 8.47, measured: false }, "NVIDIA A100-SXM4-80GB": { rate: 11.77, measured: false } };
const BUDGET_FILE = path.join(HOME, "budget.json");
const LEDGER_FILE = path.join(HOME, "ledger.json");
const CATALOG_FILE = path.join(HOME, "catalog.json");
const CONFIG_FILE = path.join(HOME, "config.json");   // preferences: starter (playwright|chrome), playwright_roots, gpu
const loadConfig = async () => loadJson(CONFIG_FILE, {});
const saveConfig = async (c) => saveJson(CONFIG_FILE, c);   // trained models: name, description, owner project, hub repo, metrics

const git = (args, cwd) => { try { return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };

// The project a model was trained from: where you ran the command, its git root, remote, branch, commit.
const ownerInfo = (cwd = process.cwd()) => {
  const root = git(["rev-parse", "--show-toplevel"], cwd);
  const o = { cwd };
  if (root) { o.git_root = root; o.remote = git(["remote", "get-url", "origin"], cwd); o.branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd); o.commit = git(["rev-parse", "--short", "HEAD"], cwd); if (git(["status", "--porcelain"], cwd)) o.dirty = true; }
  return o;
};
// Runtime discovery: the notebook publishes {url, started, gpu} to the private dataset
// repo <user>/colab-harness-state on Hugging Face; a bare `connect` reads it from there.
const hfLocalToken = async () => process.env.HF_TOKEN?.trim() || (await readFile(path.join(homedir(), ".cache/huggingface/token"), "utf8").catch(() => "")).trim() || null;
const hfWhoami = async (tok) => fetch("https://huggingface.co/api/whoami-v2", { headers: { authorization: `Bearer ${tok}` } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const discoverRuntimes = async () => {
  const tok = await hfLocalToken(); if (!tok) return { error: "no local Hugging Face login (run: hf auth login, or set HF_TOKEN)" };
  const who = await hfWhoami(tok); if (!who?.name) return { error: "local Hugging Face token rejected" };
  const repo = `${who.name}/colab-harness-state`; const hdr = { authorization: `Bearer ${tok}` };
  const tree = await fetch(`https://huggingface.co/api/datasets/${repo}/tree/main/runtimes`, { headers: hdr }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const runtimes = [];
  for (const f of Array.isArray(tree) ? tree : []) {
    if (!/\.json$/.test(f.path)) continue;
    const rec = await fetch(`https://huggingface.co/datasets/${repo}/resolve/main/${f.path}`, { headers: hdr }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (rec?.url) runtimes.push({ ...rec, file: f.path });
  }
  return { repo, user: who.name, runtimes: runtimes.sort((a, b) => (b.started ?? "").localeCompare(a.started ?? "")), tok };
};
const retireRuntime = async (d, file) => {   // delete a stale record with one commit
  const body = [JSON.stringify({ key: "header", value: { summary: "runtime gone" } }), JSON.stringify({ key: "deletedFile", value: { path: file } })].join("\n");
  await fetch(`https://huggingface.co/api/datasets/${d.repo}/commit/main`, { method: "POST", headers: { authorization: `Bearer ${d.tok}`, "content-type": "application/x-ndjson" }, body }).catch(() => null);
};
const probe = async (url, token) => fetch(url.replace(/\/+$/, "") + "/health", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const savedSessions = async () => { const { readdir } = await import("node:fs/promises"); let names = []; try { names = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { /* none */ } const out = []; for (const n of names.sort()) out.push({ name: n, ...JSON.parse(await readFile(sessionFile(n), "utf8")) }); return out; };
const loadCatalog = async () => loadJson(CATALOG_FILE, []);
const saveCatalog = async (c) => saveJson(CATALOG_FILE, c);
const catalogUpsert = async (entry) => { const c = await loadCatalog(); const i = c.findIndex((e) => e.name === entry.name); if (i >= 0) c[i] = { ...c[i], ...entry }; else c.push(entry); await saveCatalog(c); return entry; };
const ownerLabel = (o = {}) => (o.remote ? o.remote.replace(/^git@github\.com:/, "github:").replace(/^https:\/\/github\.com\//, "github:").replace(/\.git$/, "") : (o.git_root ?? o.cwd ?? "-"));
const entryText = (e) => JSON.stringify([e.name, e.description, e.tags, e.train?.base, e.train?.dataset, e.hub?.repo, e.owner?.remote, e.owner?.git_root, e.owner?.cwd, e.job?.script, e.job?.args]).toLowerCase();
const parseSummary = (stdoutTail = "") => { const m = stdoutTail.match(/^SUMMARY (\{.*\})$/m); if (!m) return null; try { return JSON.parse(m[1]); } catch { return null; } };
const printCatalog = (rows) => {
  if (!rows.length) { console.log("no models catalogued (train with: script <file> --push <repo> --description \"...\")"); return; }
  const cols = [["name", (e) => e.name], ["base", (e) => e.train?.base ?? "-"], ["dataset", (e) => e.train?.dataset ?? "-"], ["steps", (e) => e.train?.steps ?? "-"], ["loss", (e) => e.train?.last_loss != null ? Number(e.train.last_loss).toFixed(3) : "-"], ["owner", (e) => ownerLabel(e.owner)], ["date", (e) => (e.created_at ?? "").slice(0, 10)], ["hub", (e) => e.hub?.url ?? (e.local ?? "-")]];
  const w = cols.map(([h, f]) => Math.max(h.length, ...rows.map((e) => String(f(e)).length)));
  console.log(cols.map(([h], i) => h.padEnd(w[i])).join("  "));
  for (const e of rows) console.log(cols.map(([, f], i) => String(f(e)).padEnd(w[i])).join("  "));
  for (const e of rows) if (e.description) console.log(`  ${e.name}: ${e.description}`);
};
const loadJson = async (f, fallback) => { try { return JSON.parse(await readFile(f, "utf8")); } catch { return fallback; } };
const saveJson = async (f, v) => { await mkdir(HOME, { recursive: true, mode: 0o700 }); await writeFile(f, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 }); };
const loadBudget = async () => ({ monthly: 100, available: null, as_of: null, rates: {}, ...(await loadJson(BUDGET_FILE, {})) });
const rateFor = (budget, gpu) => { const r = budget.rates[gpu] ?? DEFAULT_RATES[gpu]; return r ? { ...r, gpu } : { rate: null, measured: false, gpu }; };
const fmtUnits = (u) => (u === null || u === undefined ? "?" : u.toFixed(2));
const pctOf = (units, monthly) => `${((100 * units) / monthly).toFixed(1)}% of ${monthly}/month`;
const now = () => Date.now() / 1000;
// The ledger records one entry per connected session: gpu, rate, started, last_seen, ended.
// Units = rate × (ended ?? last_seen − started). Sessions killed by the lease close lazily.
const touchLedger = async (session, health) => {
  const ledger = await loadJson(LEDGER_FILE, []);
  const budget = await loadBudget();
  let e = ledger.find((x) => x.url === session.url && !x.ended);
  const gpu = health.gpu?.name ?? "unknown";
  const t = now();
  if (!e) { const r = rateFor(budget, gpu); e = { session: session.name ?? SESSION_NAME, url: session.url, gpu, rate: r.rate, measured: r.measured, started: t - (health.uptime_s ?? 0), last_seen: t, ended: null }; ledger.push(e); }
  else e.last_seen = t;
  await saveJson(LEDGER_FILE, ledger);
  return e;
};
const closeLedger = async (url, endedAt) => { const ledger = await loadJson(LEDGER_FILE, []); for (const e of ledger) if (e.url === url && !e.ended) e.ended = endedAt ?? e.last_seen; await saveJson(LEDGER_FILE, ledger); };
const spentSince = async (asOf) => { const since = asOf ? Date.parse(asOf) / 1000 : 0; const ledger = await loadJson(LEDGER_FILE, []); return ledger.reduce((s, e) => { const a = Math.max(e.started, since), b = e.ended ?? e.last_seen; return s + (e.rate && b > a ? e.rate * ((b - a) / 3600) : 0); }, 0); };
const unitsOf = (e) => (e.rate === null ? null : (e.rate * (((e.ended ?? e.last_seen) - e.started) / 3600)));

let SESSION_NAME = "default";
function hfLine(h) {
  const hf = h.hf ?? {};
  if (!hf.token) return "hf: no HF_TOKEN secret (gated models and pushes unavailable)";
  if (hf.error) return `hf: token rejected (${hf.error})`;
  return `hf: ${hf.user} · ${hf.role} token · ${hf.write ? "can push (private repos)" : "READ-ONLY, pushes will fail: create a write token and update the Colab secret"}`;
}

async function requireHfWrite(session) {
  const h = await api(session, "GET", "/health");
  const hf = h.hf ?? {};
  if (!hf.token) die("--push needs the HF_TOKEN Colab secret (see recipes/setup-hf.md)");
  if (hf.error) die(`--push: HF_TOKEN rejected by huggingface.co: ${hf.error}`);
  if (!hf.write) die(`--push: HF_TOKEN is a ${hf.role} token and cannot write. Create a write token at https://huggingface.co/settings/tokens, replace the HARNESS secret value, then restart the runtime (or: node colab.mjs reload).`);
  return hf;
}

const loadSession = async () => {
  try { return JSON.parse(await readFile(sessionFile(SESSION_NAME), "utf8")); }
  catch { die(`no session "${SESSION_NAME}"; run the notebook and use: connect <url> --session ${SESSION_NAME} (looked in ${sessionFile(SESSION_NAME)})`, 1); }
};

// soft: return null when the runtime is unreachable (supervision decides what to do) instead of exiting.
const api = async (session, method, route, { json, body, headers = {}, raw = false, soft = false } = {}) => {
  const res = await fetch(session.url + route, {
    method, body: json !== undefined ? JSON.stringify(json) : body,
    headers: { authorization: `Bearer ${session.token}`, ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
  }).catch((e) => (soft ? null : die(`cannot reach ${session.url}: ${e.cause?.code ?? e.message}. Is the notebook still running?`, 1)));
  if (soft && (!res || res.status >= 500)) return null;
  if (raw) return res;
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${data.detail ?? data.error ?? data.raw ?? text.slice(0, 200)}`, 1);
  return data;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let FOLLOW = false;   // --follow: stream the job's stdout/stderr while waiting
const waitJob = async (session, id, { quiet = false } = {}) => {
  let last = "", off = { o: 0, e: 0 };
  for (;;) {
    const job = await api(session, "GET", `/jobs/${id}`);
    if (!quiet && job.status !== last) { console.error(`[${id}] ${job.status}`); last = job.status; }
    if (FOLLOW && job.status !== "queued") {
      const t = await api(session, "GET", `/jobs/${id}/tail?offset_out=${off.o}&offset_err=${off.e}`);
      off = { o: t.offset_out, e: t.offset_err };
      if (t.stdout) process.stderr.write(t.stdout);
      if (t.stderr) process.stderr.write(t.stderr);
    }
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

// Local file → chunked upload; --from-job → reuse the VM-side file of an earlier job.
const audioParams = async (session, file, opt) => {
  if (opt["from-job"]) return { input_job: opt["from-job"], ...(opt["from-file"] ? { input_file: opt["from-file"] } : {}) };
  if (!file) die("give an audio file or --from-job <id>");
  return { upload_id: await upload(session, file) };
};

const cookieHint = "COOKIE_EXPIRED: export cookies.txt for youtube.com from a logged-in browser (Netscape format, e.g. the 'Get cookies.txt LOCALLY' extension) and save it as " + YT_COOKIES + " — then rerun. An agent must ask the user to do this; it must not read or print the file.";

const runYoutube = async (session, url, opt) => {
  const params = { url };
  if (!opt["no-cookies"]) {
    let cookiesPath = opt.cookies ?? YT_COOKIES;
    let exists = true; try { await stat(cookiesPath); } catch { exists = false; }
    if (exists) { console.error(`uploading cookies from ${cookiesPath} (job-scoped, deleted on the VM after use)`); params.upload_id = await upload(session, cookiesPath); }
    else if (opt.cookies) die(`cookies file not found: ${cookiesPath}`);
    else console.error(`no cookies file at ${YT_COOKIES}; trying without (YouTube may refuse from Colab IPs)`);
  }
  const job = await submit(session, "youtube", params);
  const done = await waitJob(session, job.id);
  if (done.status === "failed") die(done.error?.includes("COOKIE_EXPIRED") ? `${done.error}\n\n${cookieHint}` : `youtube job failed: ${done.error}`, 1);
  return done;
};

const CLI = fileURLToPath(import.meta.url);
const runCli = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => resolve(code ?? 1));
});
const slog = (msg) => console.error(`[supervise ${new Date().toISOString().slice(11, 19)}] ${msg}`);

/**
 * Run a job to completion across runtime deaths: renew the lease, notice when the runtime stops
 * answering, start a fresh one, and resubmit the same script. The script itself must checkpoint
 * (see recipes/train-and-scripts.md) and be told to resume through --resume-env; without that a
 * restart begins the work again from zero.
 */
const superviseJob = async (session, kind, params, { outDir, all = false, opt = {} }) => {
  const pollMs = Number(opt.poll ?? 20) * 1000;
  const keepMs = Number(opt["keep-every"] ?? 10) * 60 * 1000;
  const keepMinutes = Number(opt.minutes ?? 60);
  const maxMisses = Number(opt.misses ?? 3);
  const maxRestarts = Number(opt.restarts ?? 3);
  const resumeEnv = opt["resume-env"] ? Object.fromEntries(String(opt["resume-env"]).split(",").map((kv) => kv.split(/=(.*)/s).slice(0, 2))) : null;
  if (!resumeEnv) slog("no --resume-env: a restart would redo the whole job. Checkpoint your script and pass one.");
  // Come back on the same accelerator: a job sized for an L4 will not fit a T4.
  let gpu = opt.gpu ?? null;
  if (!gpu) {
    const h = await api(session, "GET", "/health", { soft: true });
    const name = h?.gpu?.name ?? "";
    gpu = /L4/.test(name) ? "L4" : /T4/.test(name) ? "T4" : /A100/.test(name) ? "A100" : null;
    if (gpu) slog(`restarts will ask for a ${gpu} (the runtime this job started on)`);
  }
  let job = await submit(session, kind, params);
  slog(`job ${job.id} submitted; polling every ${pollMs / 1000}s, lease +${keepMinutes} min every ${keepMs / 60000} min`);
  let misses = 0, restarts = 0, lastKeep = Date.now(), lastStatus = "";
  for (;;) {
    const cur = await api(session, "GET", `/jobs/${job.id}`, { soft: true });
    if (cur) {
      misses = 0;
      if (cur.status !== lastStatus) { slog(`job ${job.id} ${cur.status}`); lastStatus = cur.status; }
      if (cur.status === "done" || cur.status === "failed") {
        await fetchFiles(session, cur, outDir, { all });
        return cur;
      }
      if (Date.now() - lastKeep > keepMs) {
        const L = await api(session, "POST", "/lease", { json: { minutes: keepMinutes }, soft: true });
        lastKeep = Date.now();
        slog(L ? `lease renewed (${Math.floor(L.expires_in_s / 60)} min left)` : "lease renewal did not answer");
      }
    } else {
      misses++;
      slog(`runtime not answering (${misses}/${maxMisses})`);
      if (misses >= maxMisses) {
        if (restarts >= maxRestarts) die(`supervise: runtime lost and ${maxRestarts} restarts used; last job ${job.id}`, 1);
        restarts++;
        slog(`runtime lost; restart ${restarts}/${maxRestarts}`);
        if (await runCli(["start", ...(gpu ? ["--gpu", String(gpu)] : [])])) die("supervise: could not start a new runtime", 1);
        if (await runCli(["connect"])) die("supervise: could not connect to the new runtime", 1);
        session = await loadSession();
        if (params.upload_id && opt._file) params = { ...params, upload_id: await upload(session, opt._file) };
        if (resumeEnv) params = { ...params, env: { ...(params.env ?? {}), ...resumeEnv } };
        await api(session, "POST", "/lease", { json: { minutes: keepMinutes }, soft: true });
        job = await submit(session, kind, params);
        lastKeep = Date.now(); misses = 0; lastStatus = "";
        slog(`resubmitted as ${job.id}${resumeEnv ? " with resume env" : ""}`);
      }
    }
    await sleep(pollMs);
  }
};

const submit = (session, kind, params) => {
  const form = new FormData();
  form.set("kind", kind);
  form.set("params", JSON.stringify(params));
  return api(session, "POST", "/jobs", { body: form });
};

const fetchFiles = async (session, job, outDir, { all = false } = {}) => {
  await mkdir(outDir, { recursive: true });
  let skipped = 0;
  for (const name of job.files ?? []) {
    if (name.startsWith("input")) continue;
    if (!all && /^checkpoint-\d+\//.test(name)) { skipped++; continue; }   // trainer checkpoints: big, --all to fetch
    // The quick tunnel occasionally stalls a download mid-body; bound each file and retry.
    const dest = path.join(outDir, name);
    await mkdir(path.dirname(dest), { recursive: true });
    // Stream to disk with an idle timeout (no bytes for 60 s) rather than a total one, so a
    // slow tunnel still completes a large file while a stalled one is retried.
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const ctl = new AbortController(); let timer = setTimeout(() => ctl.abort(), 60000);
      try {
        const res = await fetch(`${session.url}/jobs/${job.id}/files/${name}`, { headers: { authorization: `Bearer ${session.token}` }, signal: ctl.signal });
        if (!res.ok) die(`GET /jobs/${job.id}/files/${name} → ${res.status}`, 1);
        const { createWriteStream } = await import("node:fs"); const out = createWriteStream(dest);
        for await (const chunk of res.body) { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), 60000); if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r()))); ok = true;
      } catch (e) { const why = ctl.signal.aborted ? "stalled (no bytes for 60 s)" : e.message; if (attempt === 3) die(`fetch ${name}: ${why} three times; the file stays on the VM (job ${job.id}) and, if pushed, on the hub`, 1); console.error(`fetch ${name}: ${why}; retrying (${attempt}/3)`); }
      finally { clearTimeout(timer); }
    }
    console.error(`saved ${dest}`);
  }
  if (skipped) console.error(`skipped ${skipped} checkpoint files (pass --all to fetch them)`);
};

const main = async () => {
  const { pos, opt } = parse(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(USAGE); return; }
  SESSION_NAME = opt.session ?? process.env.COLAB_SESSION ?? "default";
  FOLLOW = "follow" in opt;
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(SESSION_NAME)) die("--session must be 1-40 chars of letters, digits, - or _");
  // one-time migration of the pre-sessions layout
  try { await stat(path.join(HOME, "session.json")); await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const { rename } = await import("node:fs/promises"); await rename(path.join(HOME, "session.json"), sessionFile("default")); } catch { /* nothing to migrate */ }

  if (cmd === "cookies") {
    // Handles the YouTube cookie file without ever printing its contents. The
    // only things reported are existence, size, cookie count, and expiry dates.
    const { readdir, rename, unlink } = await import("node:fs/promises");
    const summarize = async () => {
      const text = await readFile(YT_COOKIES, "utf8");
      const rows = text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")).filter((f) => f.length >= 7);
      const yt = rows.filter((f) => /youtube\.com$/.test(f[0].replace(/^\./, "")) || /google\.com$/.test(f[0].replace(/^\./, "")));
      const expiries = yt.map((f) => Number(f[4])).filter((n) => n > 0);
      const earliest = expiries.length ? new Date(Math.min(...expiries) * 1000) : null;
      const st = await stat(YT_COOKIES);
      return { cookies: rows.length, youtube_or_google: yt.length, earliest_expiry: earliest ? earliest.toISOString().slice(0, 10) : "session-only", bytes: st.size, placed: st.mtime.toISOString().slice(0, 16).replace("T", " ") };
    };
    const [sub, fileArg] = rest;
    if (sub === "status") {
      try { const s = await summarize(); console.log(`cookie file: present · ${s.youtube_or_google} youtube/google cookies of ${s.cookies} · earliest expiry ${s.earliest_expiry} · placed ${s.placed}`); }
      catch { console.log(`cookie file: none at ${YT_COOKIES}`); process.exit(1); }
      return;
    }
    if (sub === "remove") { try { await unlink(YT_COOKIES); console.log("cookie file removed"); } catch { console.log("no cookie file to remove"); } return; }
    if (sub === "install") {
      let src = fileArg;
      if (!src) {
        const dl = path.join(homedir(), "Downloads");
        const cands = (await readdir(dl)).filter((f) => /cookies?\.txt$/i.test(f) && /youtube|google/i.test(f));
        const dated = await Promise.all(cands.map(async (f) => ({ f, t: (await stat(path.join(dl, f))).mtimeMs })));
        dated.sort((a, b) => b.t - a.t);
        if (!dated.length) die(`no youtube cookies export found in ${dl}; export one (see recipes/setup-youtube-cookies.md) or pass the file path`);
        src = path.join(dl, dated[0].f);
      }
      const head = (await readFile(src, "utf8")).slice(0, 200);
      if (!/# (Netscape )?HTTP Cookie File|\t/.test(head)) die(`${src} does not look like a Netscape cookies.txt export`);
      await mkdir(HOME, { recursive: true, mode: 0o700 });
      await rename(src, YT_COOKIES).catch(async () => { await writeFile(YT_COOKIES, await readFile(src)); await unlink(src); });
      const { chmod } = await import("node:fs/promises"); await chmod(YT_COOKIES, 0o600);
      const s = await summarize();
      console.log(`installed from ${path.basename(src)} → ${YT_COOKIES} (mode 600)\n${s.youtube_or_google} youtube/google cookies · earliest expiry ${s.earliest_expiry}${s.youtube_or_google === 0 ? "\nWARNING: no youtube.com cookies in this file; export while on youtube.com, for the current site" : ""}`);
      return;
    }
    die("usage: cookies install [file] | status | remove");
  }

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
    let [url, tokenArg] = rest;
    let token = tokenArg;
    if (!token) {
      try { token = (await readFile(TOKEN_FILE, "utf8")).trim(); }
      catch { die("no token given and none stored; run: node colab.mjs init"); }
    }
    if (!url) {
      // No URL given: first the one the local starter just brought up (last-start.json),
      // then the ones the notebook published to the hub, newest first, skipping ones
      // already bound to another session and retiring ones that no longer answer.
      try { const rec = JSON.parse(await readFile(path.join(HOME, "last-start.json"), "utf8")); if (rec.url && await probe(rec.url, token)) { url = rec.url; console.error(`using the runtime started locally at ${rec.started} (${rec.gpu})`); } } catch { /* none */ }
    }
    if (!url) {
      const d = await discoverRuntimes();
      if (d.error) die(`connect: no URL given and ${d.error}; pass the URL printed by the notebook's cell 4`);
      const taken = new Set((await savedSessions()).filter((s) => s.name !== SESSION_NAME).map((s) => s.url));
      for (const r of d.runtimes) {
        if (taken.has(r.url.replace(/\/+$/, ""))) continue;
        if (await probe(r.url, token)) { url = r.url; console.error(`found runtime published ${r.started} (${r.gpu}) in ${d.repo}`); break; }
        await retireRuntime(d, r.file);
      }
      if (!url) die(d.runtimes.length ? "connect: the published runtimes no longer answer (retired them). Start one: open the notebook and Run all, then connect again." : `connect: no runtime published in ${d.repo}. Start one: open the notebook, pick L4, Run all, wait ~2 min, then \`connect\` again.`, 1);
    }
    const session = { name: SESSION_NAME, url: url.replace(/\/+$/, ""), token, connected_at: new Date().toISOString() };
    await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile(SESSION_NAME), JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
    const h = await api(session, "GET", "/health");
    const e = await touchLedger(session, h);
    const budget = await loadBudget();
    console.log(`connected [${SESSION_NAME}]: ${session.url}\ngpu: ${h.gpu.name ?? h.gpu.error} · drive: ${h.drive_mounted ? "mounted" : "not mounted"} · uptime ${h.uptime_s}s\n${hfLine(h)}`);
    console.log(e.rate === null ? `cost: unknown rate for "${e.gpu}"; set it with: budget rate --gpu "${e.gpu}" --units-per-hour N`
      : `cost: ≈${e.rate} units/h${e.measured ? "" : " (estimated)"} → ${pctOf(e.rate, budget.monthly)} per hour${budget.available !== null ? `; balance ≈${fmtUnits(budget.available - (await spentSince(budget.as_of)))} units` : ""}`);
    return;
  }

  if (cmd === "sessions") {
    const { readdir } = await import("node:fs/promises");
    let names = [];
    try { names = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)); } catch { /* none */ }
    if (!names.length) { console.log("no sessions saved"); return; }
    for (const name of names.sort()) {
      const s = JSON.parse(await readFile(sessionFile(name), "utf8"));
      const res = await fetch(s.url + "/health", { headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      let state = "unreachable";
      if (res?.ok) { const h = await res.json(); const e = await touchLedger(s, h); state = `up · ${h.gpu.name ?? "no gpu"} · lease ${Math.max(0, Math.floor(h.lease.expires_in_s / 60))} min · vllm ${h.vllm.model ?? "-"} · ≈${fmtUnits(unitsOf(e))} u`; }
      else await closeLedger(s.url);
      console.log(`${name.padEnd(12)} ${state.padEnd(60)} ${s.url}  (connected ${s.connected_at})`);
    }
    return;
  }

  if (cmd === "config") {
    const cfg = await loadConfig(); const [sub, key, value] = rest;
    if (sub === "set") { if (!["starter", "gpu"].includes(key)) die("config set starter playwright|chrome | config set gpu L4"); if (key === "starter" && !["playwright", "chrome"].includes(value)) die("starter must be playwright or chrome"); cfg[key] = value; await saveConfig(cfg); }
    console.log(JSON.stringify(cfg, null, 2)); return;
  }

  if (cmd === "auth") {
    // Google auth for the playwright starter, handled like the YouTube cookies: the user
    // exports, one command files it, nothing is ever read, printed, or typed by an agent.
    const GOOGLE_COOKIES = path.join(HOME, "google-cookies.txt");
    const { readdir, rename, unlink, rm } = await import("node:fs/promises");
    const runStart = (sub) => new Promise((r) => spawn(process.execPath, [path.join(SCRIPTS, "colab-start.mjs"), sub], { stdio: "inherit" }).on("exit", r));
    const [sub = "message", fileArg] = rest;
    if (sub === "message") {
      console.log(`To start Colab runtimes without anyone in the loop, the skill drives its own Chrome profile.
It signs in with cookies you export once; nothing is typed and the file never passes through the chat.

1. In the Chrome where you are logged into Google Colab, install "Get cookies.txt LOCALLY":
   https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc
2. Open https://www.google.com/ logged in as the account with Colab Pro (check the avatar top right),
   click the extension icon, choose Export. A file named google.com_cookies.txt lands in Downloads.
   It must be the google.com page, not Colab: the login cookies (SID, __Secure-1PSID) live on .google.com
   and the extension only exports the current site.
3. Run:
   node ${path.join(SCRIPTS, "colab.mjs")} auth install
   It moves the newest Google export from Downloads to ~/.colab-harness/google-cookies.txt
   (owner-only), seeds the profile, and prints only the cookie count and the account it signed in as.

When Google expires the session, weeks or months later, a start fails with AUTH_EXPIRED and you
repeat steps 2 and 3.`); return;
    }
    if (sub === "install") {
      let src = fileArg;
      if (!src) { const dl = path.join(homedir(), "Downloads"); const files = (await readdir(dl).catch(() => [])).filter((f) => /cookies.*\.txt$/i.test(f) && /google|colab/i.test(f)); if (!files.length) die(`no Google cookie export in ${dl}; run: node colab.mjs auth   (for the steps), or pass the file path`); const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(path.join(dl, f))).mtimeMs }))); src = path.join(dl, withTime.sort((a, b) => b.t - a.t)[0].f); }
      const text = await readFile(src, "utf8").catch(() => die(`cannot read ${src}`));
      const rows = text.split("\n").filter((l) => l && !l.startsWith("#") || l.startsWith("#HttpOnly_")).map((l) => l.replace(/^#HttpOnly_/, "").split("\t")).filter((f) => f.length >= 7);
      const g = rows.filter((f) => /google\.com$|googleusercontent\.com$/.test(f[0].replace(/^\./, "")));
      if (!g.length) die(`${path.basename(src)} holds no google.com cookies; export from https://www.google.com/ while logged in`);
      if (!g.some((f) => /^(SID|__Secure-1PSID|__Secure-3PSID)$/.test(f[5]))) die(`${path.basename(src)} has ${g.length} cookies but none of the Google login cookies (SID / __Secure-1PSID). Export from https://www.google.com/ (not the Colab page) while logged in; leaving the file in Downloads untouched.`);
      await mkdir(HOME, { recursive: true, mode: 0o700 });
      await rename(src, GOOGLE_COOKIES).catch(async () => { await writeFile(GOOGLE_COOKIES, text, { mode: 0o600 }); await unlink(src).catch(() => {}); });
      const { chmod } = await import("node:fs/promises"); await chmod(GOOGLE_COOKIES, 0o600);
      const exp = g.map((f) => Number(f[4])).filter((n) => n > 0); const earliest = exp.length ? new Date(Math.min(...exp) * 1000).toISOString().slice(0, 10) : "session-only";
      console.log(`installed from ${path.basename(src)} → ${GOOGLE_COOKIES} · ${g.length} google cookies of ${rows.length} · earliest expiry ${earliest}`);
      if (opt["no-seed"]) return;
      console.log("seeding the playwright profile and checking the sign-in…");
      process.exit(await runStart("seed"));
    }
    if (sub === "status") { try { await stat(GOOGLE_COOKIES); } catch { console.log(`google cookies: none (${GOOGLE_COOKIES}); run: node colab.mjs auth`); process.exit(1); } process.exit(await runStart("status")); }
    if (sub === "remove") { await unlink(GOOGLE_COOKIES).catch(() => {}); await rm(path.join(HOME, "chrome"), { recursive: true, force: true }); console.log("removed the google cookie file and the playwright profile"); return; }
    die("usage: auth [message|install [file]|status|remove]");
  }

  if (cmd === "start") {
    const cfg = await loadConfig(); const via = opt.via ?? cfg.starter;
    if (!via) die("no starter set. Ask the user: playwright (headless, own Google-signed-in profile) or chrome (the Claude extension)? Then: node colab.mjs config set starter <choice>, or pass --via for this run.");
    if (via === "chrome") { console.log("starter=chrome: drive the Claude in Chrome extension yourself: open the notebook, Runtime → Change runtime type → " + (opt.gpu ?? cfg.gpu ?? "L4") + ", Run all, then `node colab.mjs connect`. Or: start --via playwright"); return; }
    if (via !== "playwright") die("--via must be playwright or chrome");
    // Detached: colab-start keeps the notebook tab open (the watchdog cell) until the runtime dies.
    const { openSync } = await import("node:fs"); await mkdir(HOME, { recursive: true, mode: 0o700 });
    const logFile = path.join(HOME, "start.log"); const fd = openSync(logFile, "a");
    let ref = "main"; try { ref = execFileSync("git", ["ls-remote", "https://github.com/apresmoi/skills", "main"], { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString().slice(0, 40); } catch { /* offline: branch */ }
    const args = [path.join(SCRIPTS, "colab-start.mjs"), "start", "--gpu", opt.gpu ?? cfg.gpu ?? "L4", "--ref", ref, ...(opt.headed ? ["--headed"] : [])];
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd] }); child.unref();
    console.error(`starting a ${opt.gpu ?? cfg.gpu ?? "L4"} runtime through playwright (pid ${child.pid}, log ${logFile}); waiting for the tunnel URL…`);
    const t0 = Date.now(); const lastStart = path.join(HOME, "last-start.json"); let before = null; try { before = (await stat(lastStart)).mtimeMs; } catch { /* none */ }
    while (Date.now() - t0 < 7 * 60 * 1000) {
      await new Promise((r) => setTimeout(r, 5000));
      try { const st = await stat(lastStart); if (st.mtimeMs !== before) { const rec = JSON.parse(await readFile(lastStart, "utf8")); console.log(`runtime up: ${rec.url}`); console.error("next: node colab.mjs connect"); return; } } catch { /* not yet */ }
      const tail = (await readFile(logFile, "utf8").catch(() => "")).trim().split("\n").slice(-1)[0] ?? "";
      if (/AUTH_EXPIRED|NO_COOKIES|not signed in/.test(tail)) die("start failed: Google auth missing or expired for the playwright profile. Send the user the steps from `node colab.mjs auth`, then they run `auth install`.", 3);
      if (/colab-start: /.test(tail) && !/playwright from/.test(tail)) die(`start failed: ${tail.replace(/^.*colab-start: /, "")}`, 1);
      let alive = true; try { process.kill(child.pid, 0); } catch { alive = false; }
      if (!alive) die(`start failed; last log line: ${tail}`, 1);
    }
    die("start: no tunnel URL after 7 min; see " + logFile, 1);
  }

  if (cmd === "check" || cmd === "doctor") {
    // The readiness report an agent runs first. Every line is  <what>: OK|WARN|MISSING · <detail> → <fix>.
    // Exit 0: a runtime is up or published (use it). 1: configured, no runtime (start one). 2: setup incomplete.
    const lines = []; let missing = 0, warn = 0;
    const ok = (what, detail) => lines.push(`${what}: OK · ${detail}`);
    const miss = (what, detail, fix) => { missing++; lines.push(`${what}: MISSING · ${detail} → ${fix}`); };
    const wrn = (what, detail, fix) => { warn++; lines.push(`${what}: WARN · ${detail}${fix ? " → " + fix : ""}`); };
    const cfg = await loadConfig();
    const major = Number(process.versions.node.split(".")[0]);
    if (major >= 18) ok("node", `v${process.versions.node}`); else miss("node", `v${process.versions.node}`, "install Node 18 or newer");
    let token = null; try { token = (await readFile(TOKEN_FILE, "utf8")).trim(); ok("harness token", "~/.colab-harness/token (the Colab secret HARNESS_TOKEN must hold the same value; only a start can prove it)"); } catch { miss("harness token", "no ~/.colab-harness/token", "node colab.mjs init, then recipes/setup-token.md"); }
    const tok = await hfLocalToken(); const who = tok ? await hfWhoami(tok) : null;
    if (who?.name) ok("hugging face (local)", `${who.name} · ${who.auth?.accessToken?.role ?? "?"} token · bare connect via the hub and models sync work`);
    else wrn("hugging face (local)", tok ? "token rejected" : "no login", "hf auth login (or HF_TOKEN); until then connect only finds runtimes the local starter brought up");
    const starter = cfg.starter;
    if (!starter) miss("starter", "no preference", "ask the user once: playwright (headless, own cookie-seeded profile) or chrome (the Claude extension); node colab.mjs config set starter <choice>");
    else if (starter === "chrome") ok("starter", "chrome · the agent drives the Claude in Chrome extension (needs that tool in this session and the same claude.ai account as the terminal); fallback: start --via playwright");
    else if (starter === "playwright") {
      let pwRoot = null; const roots = [process.env.PLAYWRIGHT_ROOT, path.join(SCRIPTS, ".."), ...(cfg.playwright_roots ?? []), process.cwd()].filter(Boolean);
      for (const r of roots) { try { await stat(path.join(r, "node_modules", "playwright", "package.json")); pwRoot = r; break; } catch { /* next */ } }
      if (pwRoot) ok("playwright", `resolved from ${pwRoot}`); else miss("playwright", "no install found", `set PLAYWRIGHT_ROOT or add a project with node_modules/playwright to "playwright_roots" in ${CONFIG_FILE}`);
      let cookies = false; try { await stat(path.join(HOME, "google-cookies.txt")); cookies = true; } catch { /* none */ }
      let held = false; try { const r = JSON.parse(await readFile(path.join(HOME, "last-start.json"), "utf8")); process.kill(r.pid, 0); held = true; } catch { /* not running */ }
      if (!cookies) miss("google auth", "no ~/.colab-harness/google-cookies.txt", "send the user the steps from `node colab.mjs auth`, then they run `auth install`");
      else if (held) ok("google auth", "profile in use by the running runtime's tab (signed in)");
      else if (pwRoot) { const st = await new Promise((r) => execFile(process.execPath, [path.join(SCRIPTS, "colab-start.mjs"), "status"], { timeout: 90000 }, (e, out) => r((out || "").trim() || "status check failed"))); if (/^signed in/.test(st)) ok("google auth", st.replace(/\s+/g, " ")); else miss("google auth", st.replace(/\s+/g, " "), "re-export from google.com and `node colab.mjs auth install` (recipes/setup-starter.md)"); }
    }
    else miss("starter", `unknown value "${starter}"`, "node colab.mjs config set starter playwright|chrome");
    try { await stat(YT_COOKIES); ok("youtube cookies", "present (optional; `cookies status` for expiry)"); } catch { lines.push("youtube cookies: none · optional, only youtube/pipeline need it (recipes/setup-youtube-cookies.md)"); }
    const cat = await loadCatalog(); lines.push(`catalog: ${cat.length} trained model${cat.length === 1 ? "" : "s"} (\`models\`)`);
    const sessions = await savedSessions(); let live = 0;
    for (const sess of sessions) { const h = token ? await probe(sess.url, sess.token ?? token) : null; if (h) { live++; lines.push(`session ${sess.name}: UP · ${h.gpu?.name ?? "no gpu"} · lease ${Math.max(0, Math.floor(h.lease.expires_in_s / 60))} min · jobs ${JSON.stringify(h.jobs)} · ${hfLine(h)}`); } else { lines.push(`session ${sess.name}: down (${sess.url})`); await closeLedger(sess.url); } }
    if (!sessions.length) lines.push("sessions: none saved");
    let published = 0;
    if (who?.name && token) { const d = await discoverRuntimes(); const bound = new Set(sessions.map((x) => x.url)); for (const r of d.runtimes ?? []) { if (bound.has(r.url)) continue; if (await probe(r.url, token)) { published++; lines.push(`published runtime not yet connected: ${r.gpu} started ${r.started} → node colab.mjs connect`); } else await retireRuntime(d, r.file); } }
    for (const l of lines) console.log(l);
    console.log("");
    let code;
    if (live) { console.log(`READY: ${live} runtime${live === 1 ? "" : "s"} up. Use it, then \`release\`.`); code = 0; }
    else if (published) { console.log("READY TO CONNECT: node colab.mjs connect"); code = 0; }
    else if (missing) { console.log(`NOT CONFIGURED: ${missing} item${missing === 1 ? "" : "s"} marked MISSING above, each with its fix. Setup order: recipes/setup-token.md → setup-hf.md → setup-starter.md.`); code = 2; }
    else if (starter === "chrome") { console.log("NO RUNTIME. Start one yourself with the Claude in Chrome extension: open the notebook, Runtime → Change runtime type → L4, Run all, then: node colab.mjs connect. No extension here? node colab.mjs start --via playwright"); code = 1; }
    else { console.log("NO RUNTIME. Start one: node colab.mjs start   (then: node colab.mjs connect). Problems: recipes/troubleshooting.md"); code = 1; }
    if (warn) console.log(`(${warn} warning${warn === 1 ? "" : "s"} above)`);
    process.exit(code);
  }

  if (cmd === "models") {
    const [sub = "list", ...q] = rest;
    let c = await loadCatalog();
    if (sub === "list") {
      if (opt.owner) c = c.filter((e) => ownerLabel(e.owner).toLowerCase().includes(String(opt.owner).toLowerCase()));
      if (opt.base) c = c.filter((e) => (e.train?.base ?? "").toLowerCase().includes(String(opt.base).toLowerCase()));
      if (opt.json) { console.log(JSON.stringify(c, null, 2)); return; }
      printCatalog(c.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))); return;
    }
    if (sub === "search") {
      const needle = q.join(" ").toLowerCase(); if (!needle) die("usage: models search <query>");
      const hits = c.filter((e) => entryText(e).includes(needle));
      if (opt.json) { console.log(JSON.stringify(hits, null, 2)); return; }
      printCatalog(hits); return;
    }
    if (sub === "show") { const e = c.find((x) => x.name === q[0]); if (!e) die(`no model named ${q[0]}`); console.log(JSON.stringify(e, null, 2)); return; }
    if (sub === "edit") {
      const e = c.find((x) => x.name === q[0]); if (!e) die(`no model named ${q[0]}`);
      if (opt.description) e.description = opt.description;
      if (opt.tags) e.tags = String(opt.tags).split(",").map((t) => t.trim()).filter(Boolean);
      if (opt.name) e.name = opt.name;
      e.updated_at = new Date().toISOString(); await saveCatalog(c); console.log(JSON.stringify(e, null, 2)); return;
    }
    if (sub === "sync") {
      // Rebuild from the hub: every model repo of yours tagged colab-harness, reading its colab-harness.json.
      let tok = process.env.HF_TOKEN; if (!tok) { try { tok = (await readFile(path.join(homedir(), ".cache/huggingface/token"), "utf8")).trim(); } catch { die("no local Hugging Face login: run `hf auth login` (or set HF_TOKEN)"); } }
      const hdr = { authorization: `Bearer ${tok}` };
      const who = await fetch("https://huggingface.co/api/whoami-v2", { headers: hdr }).then((r) => r.json());
      if (!who.name) die("Hugging Face token rejected");
      const repos = await fetch(`https://huggingface.co/api/models?author=${who.name}&filter=colab-harness&limit=500`, { headers: hdr }).then((r) => r.json());
      let added = 0;
      for (const r of repos) {
        const card = await fetch(`https://huggingface.co/${r.id}/resolve/main/colab-harness.json`, { headers: hdr }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
        const name = card?.name ?? r.id.split("/").pop();
        if (c.some((e) => e.name === name || e.hub?.repo === r.id)) continue;
        const sm = card?.summary;
        c.push({ name, description: card?.description ?? null, tags: card?.tags ?? [], created_at: card?.pushed_at ?? r.createdAt ?? new Date().toISOString(), owner: card?.owner ?? null,
          hub: { repo: r.id, url: `https://huggingface.co/${r.id}`, private: r.private }, local: null, job: card ? { id: card.job, script: card.script, args: card.args } : null,
          train: sm ? { base: sm.model, dataset: sm.dataset, samples: sm.samples, steps: sm.steps, first_loss: sm.first_loss, last_loss: sm.last_loss, train_seconds: sm.train_seconds } : null, synced_from_hub: true });
        added++;
      }
      await saveCatalog(c);
      console.log(`hub: ${repos.length} repos tagged colab-harness for ${who.name}; added ${added} to the catalog (${c.length} total)`);
      return;
    }
    die("usage: models [list|search <q>|show <name>|edit <name>|sync]");
  }

  const session = await loadSession();

  if (cmd === "status") {
    const h = await api(session, "GET", "/health");
    const e = await touchLedger(session, h);
    console.log(JSON.stringify(h, null, 2));
    if (h.lease) console.error(`lease: ${Math.max(0, Math.floor(h.lease.expires_in_s / 60))} min left${h.lease.busy ? " (job running, kept alive)" : ""}${h.lease.shutdown ? " · RELEASE REQUESTED" : ""}`);
    console.error(`cost: ≈${fmtUnits(unitsOf(e))} units this session (${e.gpu}${e.rate !== null ? `, ${e.rate}/h${e.measured ? "" : " est."}` : ", unknown rate"})`);
    return;
  }
  if (cmd === "cost" || cmd === "budget") {
    const budget = await loadBudget();
    const [sub] = rest;
    if (cmd === "budget" && sub === "set") {
      if (opt.monthly) budget.monthly = Number(opt.monthly);
      if (opt.available !== undefined) { budget.available = Number(opt.available); budget.as_of = new Date().toISOString(); }
      await saveJson(BUDGET_FILE, budget);
      console.log(`budget: ${budget.monthly} units/month${budget.available !== null ? `, balance ${budget.available} as of ${budget.as_of.slice(0, 16)}` : ""}`);
      return;
    }
    if (cmd === "budget" && sub === "rate") {
      if (!opt.gpu || !opt["units-per-hour"]) die('usage: budget rate --gpu "<name as in status>" --units-per-hour N');
      budget.rates[opt.gpu] = { rate: Number(opt["units-per-hour"]), measured: true };
      await saveJson(BUDGET_FILE, budget);
      console.log(`rate for ${opt.gpu}: ${opt["units-per-hour"]} units/h (measured)`);
      return;
    }
    // cost report: this month by session, live sessions counted to now
    const ledger = await loadJson(LEDGER_FILE, []);
    const month = new Date().toISOString().slice(0, 7);
    const rows = ledger.filter((e) => new Date(e.started * 1000).toISOString().slice(0, 7) === month);
    let total = 0;
    for (const e of rows) { const un = unitsOf(e); total += un ?? 0; const hrs = (((e.ended ?? e.last_seen) - e.started) / 3600).toFixed(2); console.log(`${new Date(e.started * 1000).toISOString().slice(0, 16).replace("T", " ")}  ${e.session.padEnd(10)} ${e.gpu.padEnd(22)} ${hrs.padStart(5)} h  ≈${fmtUnits(un).padStart(6)} u${e.ended ? "" : "  (open)"}${e.measured || e.rate === null ? "" : "  est."}`); }
    console.log(`this month: ≈${total.toFixed(2)} units = ${pctOf(total, budget.monthly)}`);
    if (budget.available !== null) { const left = budget.available - (await spentSince(budget.as_of)); console.log(`balance: ≈${left.toFixed(2)} units left (seeded ${budget.available} on ${budget.as_of.slice(0, 10)}; refresh with: budget set --available <n from Colab's Resources panel>)`); }
    else console.log("balance: unknown; seed it with: budget set --available <units shown in Colab's Resources panel>");
    return;
  }
  if (cmd === "keep") {
    const minutes = Number(opt.minutes ?? 120);
    const h = await api(session, "GET", "/health");
    const e = await touchLedger(session, h);
    const budget = await loadBudget();
    const est = e.rate === null ? null : e.rate * (minutes / 60);
    if ("dry-run" in opt) { console.log(`keeping ${e.gpu} up ${minutes} min ≈ ${fmtUnits(est)} units${e.measured ? "" : " (estimated rate)"} = ${est === null ? "?" : pctOf(est, budget.monthly)}`); return; }
    const L = await api(session, "POST", "/lease", { json: { minutes } });
    console.log(`lease set: ${Math.floor(L.expires_in_s / 60)} min ≈ ${fmtUnits(est)} units if idle the whole time (${e.gpu}, ${e.rate ?? "?"}/h)`);
    return;
  }
  if (cmd === "release") {
    const h = await api(session, "GET", "/health");
    const e = await touchLedger(session, h);
    const L = await api(session, "POST", "/shutdown", { json: { stop_vllm: true } });
    await closeLedger(session.url, now());
    console.log(`release requested; the notebook's watchdog unassigns the runtime within a minute. session cost ≈${fmtUnits(unitsOf(e))} units (${e.gpu}).`);
    return;
  }
  if (cmd === "progress") {
    // One line per queued/running job across every saved session, with a bar when
    // the job's last log line carries "n/m" or "n%". Meant to be printed in chat.
    const { readdir } = await import("node:fs/promises");
    let names = []; try { names = (await readdir(SESSIONS_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(); } catch { /* none */ }
    if (!names.length) { console.log("no sessions"); return; }
    const bar = (p) => { const n = Math.round(p / 5); return `[${"#".repeat(n)}${"-".repeat(20 - n)}] ${Math.round(p)}%`; };
    let any = false;
    for (const name of names) {
      const s = JSON.parse(await readFile(sessionFile(name), "utf8"));
      const res = await fetch(s.url + "/jobs", { headers: { authorization: `Bearer ${s.token}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      if (!res?.ok) { console.log(`${name}: unreachable`); continue; }
      const live = (await res.json()).filter((j) => j.status === "running" || j.status === "queued");
      if (!live.length) { console.log(`${name}: idle`); continue; }
      for (const j of live) {
        any = true;
        const elapsed = j.started ? `${Math.round(Date.now() / 1000 - j.started)}s` : "-";
        let lastLine = "";
        try { const t = await (await fetch(`${s.url}/jobs/${j.id}/tail`, { headers: { authorization: `Bearer ${s.token}` } })).json(); lastLine = (t.stdout + t.stderr).trim().split("\n").filter(Boolean).at(-1) ?? ""; } catch { /* no tail */ }
        const m = /(\d+)\s*\/\s*(\d+)/.exec(lastLine) ?? /(\d+(?:\.\d+)?)\s*%/.exec(lastLine);
        const pct = m ? (m[2] ? (100 * Number(m[1])) / Number(m[2]) : Number(m[1])) : null;
        console.log(`${name.padEnd(10)} ${j.kind.padEnd(10)} ${j.id.slice(-6)}  ${j.status.padEnd(7)} ${elapsed.padStart(6)}  ${pct !== null ? bar(Math.min(100, pct)) : ""}${lastLine ? "  " + lastLine.slice(0, 70) : ""}`);
      }
    }
    if (!any) console.log("no running jobs");
    return;
  }

  if (cmd === "ui") {
    const url = `${session.url}/ui`;
    console.log(`${url}\n(paste the token once in the page; it stays in that browser's localStorage)`);
    if (!("no-open" in opt)) { const { spawn } = await import("node:child_process"); spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true }).unref(); }
    return;
  }
  if (cmd === "env") { console.log(`export OPENAI_BASE_URL=${session.url}/v1\nexport OPENAI_API_KEY=${session.token}`); return; }
  if (cmd === "jobs") {
    for (const j of await api(session, "GET", "/jobs")) console.log(`${j.id}  ${j.kind.padEnd(10)} ${j.status.padEnd(7)} ${j.error ?? ""}`);
    return;
  }
  if (cmd === "job") { console.log(JSON.stringify(await api(session, "GET", `/jobs/${rest[0]}`), null, 2)); return; }
  if (cmd === "fetch") {
    const job = await api(session, "GET", `/jobs/${rest[0]}`);
    await fetchFiles(session, job, opt.out ?? path.join("colab-jobs", job.id), { all: "all" in opt });
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

  if (cmd === "youtube") {
    const url = rest[0];
    if (!url) die("usage: youtube <url> [--cookies PATH] [--no-cookies] [--fetch-audio] [--out DIR]");
    const done = await runYoutube(session, url, opt);
    const outDir = opt.out ?? path.join("colab-jobs", done.id);
    await fetchFiles(session, { ...done, files: done.files.filter((f) => "fetch-audio" in opt || !f.endsWith(".wav")) }, outDir);
    console.log(JSON.stringify({ id: done.id, ...done.result, audio_on_vm: "audio.wav", out: outDir }, null, 2));
    return;
  }

  if (cmd === "diarize") {
    const params = { ...(await audioParams(session, rest[0], opt)) };
    if (opt.speakers) params.num_speakers = Number(opt.speakers);
    const job = await submit(session, "diarize", params);
    const done = await waitJob(session, job.id);
    if (done.status === "failed") die(`diarization failed: ${done.error}`, 1);
    const outDir = opt.out ?? path.join("colab-jobs", job.id);
    await fetchFiles(session, { ...done, files: done.files.filter((f) => !f.endsWith(".wav")) }, outDir);
    console.log(JSON.stringify({ id: job.id, ...done.result, out: outDir }, null, 2));
    return;
  }

  if (cmd === "pipeline") {
    const src = rest[0];
    if (!src) die("usage: pipeline <url|audio> [--language xx] [--speakers N] [--out DIR]");
    let sourceJob;
    if (/^https?:\/\//.test(src)) { sourceJob = await runYoutube(session, src, opt); console.error(`downloaded: ${sourceJob.result.title}`); }
    else { const uploadId = await upload(session, src); const j = await submit(session, "shell", { cmd: "mv input.* audio.wav", upload_id: uploadId }); sourceJob = await waitJob(session, j.id, { quiet: true }); }
    const dParams = { input_job: sourceJob.id, input_file: "audio.wav" };
    if (opt.speakers) dParams.num_speakers = Number(opt.speakers);
    const dJob = await waitJob(session, (await submit(session, "diarize", dParams)).id);
    if (dJob.status === "failed") die(`diarization failed: ${dJob.error}`, 1);
    console.error(`diarized: ${(dJob.result.speakers ?? []).length} speakers`);
    const tParams = { input_job: sourceJob.id, input_file: "audio.wav", diarization_job: dJob.id, model: opt.model ?? "large-v3" };
    if (opt.language) tParams.language = opt.language;
    const tJob = await waitJob(session, (await submit(session, "transcribe", tParams)).id);
    if (tJob.status === "failed") die(`transcription failed: ${tJob.error}`, 1);
    const outDir = opt.out ?? path.join("colab-jobs", tJob.id);
    await fetchFiles(session, { ...sourceJob, files: sourceJob.files.filter((f) => f.endsWith(".json")) }, outDir);
    await fetchFiles(session, { ...dJob, files: dJob.files.filter((f) => f.endsWith(".json")) }, outDir);
    await fetchFiles(session, { ...tJob, files: tJob.files.filter((f) => !f.startsWith("input")) }, outDir);
    console.log(JSON.stringify({ youtube: sourceJob.id, diarize: dJob.id, transcribe: tJob.id, ...tJob.result, out: outDir }, null, 2));
    return;
  }

  if (cmd === "transcribe") {
    const file = rest[0];
    if (!file && !opt["from-job"]) die("usage: transcribe <audio | --from-job ID> [--model M] [--language xx] [--diarization JOB] [--out DIR]");
    const params = { ...(await audioParams(session, file, opt)), model: opt.model ?? "large-v3" };
    if (opt.diarization) params.diarization_job = opt.diarization;
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

  if (cmd === "script") {
    const file = rest[0];
    if (!file) die("usage: script <file.py|.sh> [--args \"a b\"] [--env K=V,...] [--python PATH] [--out DIR]");
    const uploadId = await upload(session, file);
    const params = { upload_id: uploadId, args: opt.args ? opt.args.split(/\s+/) : [], timeout: Number(opt.timeout ?? 21600) };
    if (opt.env) params.env = Object.fromEntries(opt.env.split(",").map((kv) => kv.split(/=(.*)/s).slice(0, 2)));
    if (opt.python) params.python = opt.python;
    const owner = ownerInfo();
    const catalogMeta = { name: opt.name ?? (opt.push ? String(opt.push).split("/").pop() : null), description: opt.description ?? null,
      tags: opt.tags ? String(opt.tags).split(",").map((t) => t.trim()).filter(Boolean) : [], owner, script: path.basename(file), args: params.args };
    if (opt.push) {
      const hf = await requireHfWrite(session);
      params.push = String(opt.push).includes("/") ? opt.push : `${hf.user}/${opt.push}`;
      params.push_dir = opt["push-dir"] ?? "adapter";
      if (opt.public) params.public = true;
      params.catalog = catalogMeta;
      console.error(`will push ${params.push_dir}/ to https://huggingface.co/${params.push} (${params.public ? "PUBLIC" : "private"}) when the script succeeds`);
    }
    const outDir = opt.out ?? path.join("colab-jobs", `job-${Date.now()}`);
    let done;
    if ("supervise" in opt) {
      done = await superviseJob(session, "script", params, { outDir, all: "all" in opt, opt: { ...opt, _file: file } });
    } else {
      const job = await submit(session, "script", params);
      done = await waitJob(session, job.id);
      await fetchFiles(session, done, outDir, { all: "all" in opt });
    }
    if (done.status === "failed") die(`script failed: ${done.error}\n(logs in ${outDir})`, 1);
    process.stdout.write(done.result.stdout_tail);
    console.error(`done; files in ${outDir}`);
    if (done.result.push) {
      const pu = done.result.push;
      console.error(`pushed ${pu.files} files (${(pu.bytes / 1e6).toFixed(1)} MB) → ${pu.url} [${pu.private ? "private" : "PUBLIC"}]`);
    }
    const summary = parseSummary(done.result.stdout_tail);
    const hasArtefact = done.result.push || (done.files ?? []).some((f) => /^adapter\//.test(f.name ?? f));
    if (catalogMeta.name || hasArtefact) {
      const name = catalogMeta.name ?? `${path.basename(file, path.extname(file))}-${job.id}`;
      const entry = { name, description: catalogMeta.description, tags: catalogMeta.tags, created_at: new Date().toISOString(), owner,
        hub: done.result.push ? { repo: done.result.push.repo, url: done.result.push.url, private: done.result.push.private, commit: done.result.push.commit, files: done.result.push.files, bytes: done.result.push.bytes } : null,
        local: path.resolve(outDir), job: { id: job.id, session: SESSION_NAME, script: path.basename(file), args: params.args, gpu: (await api(session, "GET", "/health").catch(() => ({}))).gpu?.name ?? null },
        train: summary ? { base: summary.model, dataset: summary.dataset, samples: summary.samples, steps: summary.steps, first_loss: summary.first_loss, last_loss: summary.last_loss, train_seconds: summary.train_seconds } : null };
      await catalogUpsert(entry);
      console.error(`catalogued "${name}" (${CATALOG_FILE})${entry.description ? "" : " — add a description: node colab.mjs models edit " + name + " --description \"...\""}`);
    }
    return;
  }


  if (cmd === "hf") {
    console.log(hfLine(await api(session, "GET", "/health")));
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
        const inst = await submit(session, "shell", { cmd: "rm -rf /content/vllm-venv && pip install -q uv && uv venv -q /content/vllm-venv && uv pip install -q --python /content/vllm-venv/bin/python vllm ninja", timeout: 2400 });
        const r = await waitJob(session, inst.id, { quiet: true });
        if (r.result?.exit_code !== 0) die(`vllm install failed:\n${r.result?.stderr_tail}`, 1);
      }
      const body = { model };
      if (opt["max-model-len"]) body.max_model_len = Number(opt["max-model-len"]);
      if (opt["vllm-args"]) body.args = opt["vllm-args"].split(/\s+/);   // e.g. --vllm-args "--enforce-eager --dtype half"
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
    // The relaunch lives in its own script file so the job's command line never
    // contains the server's name: pkill -f would otherwise kill the relauncher.
    const restart = Buffer.from("sleep 1\npkill -f 'harness_server.py'\nsleep 1\ncd /content\nexec python /content/harness_server.py > /content/harness_server.log 2>&1\n").toString("base64");
    const script = `echo ${b64} | base64 -d > /content/harness_server.py && python -c "import ast; ast.parse(open('/content/harness_server.py').read())" && echo ${restart} | base64 -d > /content/harness_restart.sh && (setsid nohup bash /content/harness_restart.sh >/dev/null 2>&1 &) && echo scheduled`;
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
