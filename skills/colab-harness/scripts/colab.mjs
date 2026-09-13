#!/usr/bin/env node
// colab-harness — drive a Colab runtime (running Colab_Harness.ipynb) from local.
// Session (tunnel URL + token) lives in ~/.colab-harness/session.json.
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

const HOME = path.join(process.env.COLAB_HARNESS_HOME ?? path.join(homedir(), ".colab-harness"));
const TOKEN_FILE = path.join(HOME, "token");
const YT_COOKIES = path.join(HOME, "youtube-cookies.txt");   // seeded by the user, never read by an agent
// Sessions are named so several runtimes can be driven at once:
//   --session train   or   COLAB_SESSION=train   (default: "default")
const SESSIONS_DIR = path.join(HOME, "sessions");
const sessionFile = (name) => path.join(SESSIONS_DIR, `${name}.json`);
const CHUNK = 8 * 1024 * 1024; // well under the tunnel's per-request cap

const USAGE = `colab-harness — use a Colab GPU runtime from here.

  node colab.mjs init                        generate the shared token once (store it as Colab secret HARNESS_TOKEN)
  node colab.mjs connect <url> [token]       save this session; token defaults to the one from init
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
  node colab.mjs script <file.py|.sh> [--args "a b"] [--env K=V,K2=V2] [--python PATH] [--out DIR]
                                             upload and run a script on the VM (train, DSPy compile, ...)
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
    if (a.startsWith("--")) { const n = argv[i + 1]; if (["follow", "no-open", "all", "no-cookies", "fetch-audio", "word-timestamps", "force", "dry-run"].includes(a.slice(2)) || n === undefined || n.startsWith("--")) opt[a.slice(2)] = true; else { opt[a.slice(2)] = n; i++; } }
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
const loadSession = async () => {
  try { return JSON.parse(await readFile(sessionFile(SESSION_NAME), "utf8")); }
  catch { die(`no session "${SESSION_NAME}"; run the notebook and use: connect <url> --session ${SESSION_NAME} (looked in ${sessionFile(SESSION_NAME)})`, 1); }
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
    const res = await api(session, "GET", `/jobs/${job.id}/files/${name}`, { raw: true });
    const dest = path.join(outDir, name);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
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
    const [url, tokenArg] = rest;
    if (!url) die("usage: connect <url> [token]");
    let token = tokenArg;
    if (!token) {
      try { token = (await readFile(TOKEN_FILE, "utf8")).trim(); }
      catch { die("no token given and none stored; run: node colab.mjs init"); }
    }
    const session = { name: SESSION_NAME, url: url.replace(/\/+$/, ""), token, connected_at: new Date().toISOString() };
    await mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    await writeFile(sessionFile(SESSION_NAME), JSON.stringify(session, null, 2) + "\n", { mode: 0o600 });
    const h = await api(session, "GET", "/health");
    const e = await touchLedger(session, h);
    const budget = await loadBudget();
    console.log(`connected [${SESSION_NAME}]: ${session.url}\ngpu: ${h.gpu.name ?? h.gpu.error} · drive: ${h.drive_mounted ? "mounted" : "not mounted"} · uptime ${h.uptime_s}s`);
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
    const job = await submit(session, "script", params);
    const done = await waitJob(session, job.id);
    const outDir = opt.out ?? path.join("colab-jobs", job.id);
    await fetchFiles(session, done, outDir, { all: "all" in opt });
    if (done.status === "failed") die(`script failed: ${done.error}\n(logs in ${outDir})`, 1);
    process.stdout.write(done.result.stdout_tail);
    console.error(`done; files in ${outDir}`);
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
