# colab-harness — job server that runs inside a Colab runtime.
# Started by the Colab_Harness notebook; reached from local through a tunnel.
# Every route requires  Authorization: Bearer <HARNESS_TOKEN>.
import json, os, shutil, subprocess, sys, threading, time, uuid
from pathlib import Path
from typing import Optional
from queue import Queue

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

TOKEN = os.environ["HARNESS_TOKEN"]
PORT = int(os.environ.get("HARNESS_PORT", "8787"))
ROOT = Path(os.environ.get("HARNESS_ROOT", "/content/harness"))
JOBS_DIR = ROOT / "jobs"
JOBS_DIR.mkdir(parents=True, exist_ok=True)
VLLM_PORT = 8000
VLLM_VENV = Path(os.environ.get("HARNESS_VLLM_VENV", "/content/vllm-venv"))
STARTED = time.time()

LEASE_MIN = int(os.environ.get("HARNESS_LEASE_MIN", "30"))
_lease = {"expires": time.time() + LEASE_MIN * 60, "shutdown": False, "renewals": 0}
# Requests that count as activity and renew the lease; polling does not.
ACTIVITY = {("POST", "/jobs"), ("POST", "/uploads"), ("POST", "/vllm/start"), ("POST", "/vllm/stop")}


def renew(minutes: int = LEASE_MIN):
    _lease["expires"] = max(_lease["expires"], time.time() + minutes * 60)
    _lease["renewals"] += 1


def lease_state() -> dict:
    busy = any(j["status"] in ("queued", "running") for j in jobs.values())
    remaining = int(_lease["expires"] - time.time())
    return {"expires_in_s": remaining, "busy": busy, "shutdown": _lease["shutdown"],
            "should_shutdown": _lease["shutdown"] or (remaining <= 0 and not busy), "default_minutes": LEASE_MIN}


app = FastAPI(title="colab-harness")
jobs: dict[str, dict] = {}
queue: Queue = Queue()
_models: dict[tuple, object] = {}
_vllm: dict = {"proc": None, "model": None, "log": ROOT / "vllm.log", "started": None}


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.url.path == "/ui":
        return await call_next(request)
    if request.headers.get("authorization") != f"Bearer {TOKEN}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    path = request.url.path
    if (request.method, path) in ACTIVITY or path.startswith("/v1/") or (request.method == "PUT" and path.startswith("/uploads/")):
        renew()
    return await call_next(request)


def gpu_info():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10).stdout.strip()
        name, used, total = [s.strip() for s in out.split(",")]
        return {"name": name, "memory_used": used, "memory_total": total}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


@app.get("/ui")
def ui():
    from fastapi.responses import HTMLResponse
    return HTMLResponse(UI_HTML)


_hf_cache: Optional[dict] = None


def hf_info() -> dict:
    # Who the HF_TOKEN belongs to and whether it can write. Computed once; the
    # token itself is never returned. Classic tokens carry role read/write; fine-grained
    # ones list permissions per scope, and any "write" permission counts.
    global _hf_cache
    if _hf_cache is not None:
        return _hf_cache
    tok = os.environ.get("HF_TOKEN")
    if not tok:
        _hf_cache = {"token": False, "write": False}
        return _hf_cache
    try:
        from huggingface_hub import HfApi
        w = HfApi(token=tok).whoami()
        at = (w.get("auth") or {}).get("accessToken") or {}
        role = at.get("role")
        fg = at.get("fineGrained") or {}
        perms = list(fg.get("global") or []) + [p for sc in (fg.get("scoped") or []) for p in (sc.get("permissions") or [])]
        write = role == "write" or any("write" in str(p) for p in perms)
        _hf_cache = {"token": True, "user": w.get("name"), "role": role, "write": bool(write)}
    except Exception as e:  # bad token, no network: report, never crash /health
        _hf_cache = {"token": True, "write": False, "error": str(e)[:200]}
    return _hf_cache


def hf_push(job: dict, repo: str, subdir: str, private: bool) -> dict:
    # Upload one folder of the job dir to a Hugging Face model repo. Private unless
    # the caller explicitly asked for public. Adds a README with the base model when
    # the folder has none, so the hub page shows the lineage.
    from huggingface_hub import HfApi
    info = hf_info()
    if not info.get("write"):
        raise RuntimeError("HF_TOKEN cannot write (" + str(info.get("role") or info.get("error") or "missing") + "); create a write token and update the Colab secret")
    folder = Path(job["dir"]) / subdir
    if not folder.is_dir():
        raise RuntimeError(f"push: {subdir}/ not found in the job dir (script finished without writing it)")
    if "/" not in repo:
        repo = f"{info['user']}/{repo}"
    readme = folder / "README.md"
    if not readme.exists():
        base = None
        cfg = folder / "adapter_config.json"
        if cfg.exists():
            try:
                base = json.loads(cfg.read_text()).get("base_model_name_or_path")
            except Exception:
                base = None
        fm = ["---", "library_name: peft" if cfg.exists() else "library_name: transformers", "tags:", "- colab-harness"]
        if cfg.exists():
            fm.append("- lora")
        if base:
            fm.append(f"base_model: {base}")
        fm.append("---")
        body = f"\n# {repo.split('/')[-1]}\n\nProduced by colab-harness job `{job['id']}`" + (f" on base `{base}`" if base else "") + ".\n"
        readme.write_text("\n".join(fm) + body)
    api = HfApi(token=os.environ["HF_TOKEN"])
    api.create_repo(repo, private=private, exist_ok=True, repo_type="model")
    # Never let an existing public repo receive a push that was asked to be private.
    if private and not api.repo_info(repo).private:
        raise RuntimeError(f"push refused: {repo} exists and is PUBLIC; pass --public to push there or choose another name")
    files = [f for f in folder.rglob("*") if f.is_file()]
    commit = api.upload_folder(folder_path=str(folder), repo_id=repo, commit_message=f"colab-harness job {job['id']}")
    return {"repo": repo, "url": f"https://huggingface.co/{repo}", "private": bool(api.repo_info(repo).private),
            "files": len(files), "bytes": sum(f.stat().st_size for f in files), "commit": getattr(commit, "oid", None)}


@app.get("/health")
def health():
    return {
        "ok": True, "hf": hf_info(), "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
        "drive_mounted": Path("/content/drive/MyDrive").exists(),
        "jobs": {s: sum(1 for j in jobs.values() if j["status"] == s) for s in ("queued", "running", "done", "failed")},
        "vllm": vllm_status(),
        "lease": lease_state(),
    }


@app.get("/lease")
def lease_get():
    return lease_state()


@app.post("/lease")
def lease_post(body: dict):
    minutes = int(body.get("minutes", LEASE_MIN))
    if minutes < 1 or minutes > 24 * 60:
        raise HTTPException(400, "minutes must be 1..1440")
    _lease["expires"] = time.time() + minutes * 60   # explicit set, may shorten
    _lease["shutdown"] = False
    return lease_state()


@app.post("/shutdown")
def shutdown(body: dict = None):
    # The keep-alive cell sees should_shutdown and unassigns the runtime.
    _lease["shutdown"] = True
    if (body or {}).get("stop_vllm", True):
        vllm_stop()
    return lease_state()


# ---------------- uploads (chunked) ----------------
UPLOADS_DIR = ROOT / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)


@app.post("/uploads")
def upload_start(body: dict):
    name = Path(body.get("filename") or "input.bin").name
    uid = uuid.uuid4().hex[:12]
    d = UPLOADS_DIR / uid
    d.mkdir()
    (d / "name").write_text(name)
    (d / "data").touch()
    return {"upload_id": uid, "filename": name}


@app.put("/uploads/{uid}")
async def upload_chunk(uid: str, request: Request):
    d = UPLOADS_DIR / uid
    if not d.is_dir():
        raise HTTPException(404, "no such upload")
    offset = int(request.headers.get("x-offset", "-1"))
    data = d / "data"
    if offset != data.stat().st_size:
        raise HTTPException(409, f"expected offset {data.stat().st_size}, got {offset}")
    body = await request.body()
    with data.open("ab") as fh:
        fh.write(body)
    return {"upload_id": uid, "size": data.stat().st_size}


@app.get("/uploads/{uid}")
def upload_status(uid: str):
    d = UPLOADS_DIR / uid
    if not d.is_dir():
        raise HTTPException(404, "no such upload")
    return {"upload_id": uid, "filename": (d / "name").read_text(), "size": (d / "data").stat().st_size}


# ---------------- jobs ----------------
def new_job(kind: str, params: dict) -> dict:
    jid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    d = JOBS_DIR / jid
    d.mkdir()
    job = {"id": jid, "kind": kind, "status": "queued", "params": params, "created": time.time(),
           "started": None, "finished": None, "error": None, "result": None, "dir": str(d)}
    jobs[jid] = job
    return job


def public(job: dict) -> dict:
    out = {k: v for k, v in job.items() if k != "dir"}
    d = Path(job["dir"])
    out["files"] = sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file()) if d.exists() else []
    return out


@app.post("/jobs")
async def submit(kind: str = Form(...), params: str = Form("{}"), file: Optional[UploadFile] = File(None)):
    if kind not in KINDS:
        raise HTTPException(400, f"unknown kind {kind!r}; known: {sorted(KINDS)}")
    try:
        p = json.loads(params)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"params is not JSON: {e}") from e
    job = new_job(kind, p)
    if file is not None:
        suffix = Path(file.filename or "input").suffix or ".bin"
        dest = Path(job["dir"]) / f"input{suffix}"
        with dest.open("wb") as fh:
            shutil.copyfileobj(file.file, fh)
        job["input"] = dest.name
    elif p.get("input_job"):
        src_dir = Path(jobs.get(str(p["input_job"]), {}).get("dir", ""))
        if not src_dir.is_dir():
            raise HTTPException(404, f"no such input_job {p['input_job']}")
        name = p.get("input_file")
        cands = [src_dir / name] if name else [src_dir / "audio.wav"] + sorted(src_dir.glob("input.*"))
        src = next((c for c in cands if c.is_file()), None)
        if src is None:
            raise HTTPException(404, f"input_job {p['input_job']} has no usable input file")
        dest = Path(job["dir"]) / f"input{src.suffix or '.bin'}"
        os.link(src, dest) if os.stat(src).st_dev == os.stat(job["dir"]).st_dev else shutil.copy(src, dest)
        job["input"] = dest.name
    elif p.get("upload_id"):
        d = UPLOADS_DIR / str(p["upload_id"])
        if not d.is_dir():
            raise HTTPException(404, f"no such upload {p['upload_id']}")
        suffix = Path((d / "name").read_text()).suffix or ".bin"
        dest = Path(job["dir"]) / f"input{suffix}"
        shutil.move(str(d / "data"), dest)
        shutil.rmtree(d, ignore_errors=True)
        job["input"] = dest.name
    queue.put(job["id"])
    return public(job)


@app.get("/jobs")
def list_jobs():
    return [public(j) for j in sorted(jobs.values(), key=lambda j: j["created"])]


@app.get("/jobs/{jid}")
def get_job(jid: str):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    return public(jobs[jid])


@app.get("/jobs/{jid}/files/{name:path}")
def get_file(jid: str, name: str):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    p = (Path(jobs[jid]["dir"]) / name).resolve()
    if not p.is_file() or Path(jobs[jid]["dir"]).resolve() not in p.parents:
        raise HTTPException(404, "no such file")
    return FileResponse(p)


@app.get("/jobs/{jid}/tail")
def job_tail(jid: str, offset_out: int = 0, offset_err: int = 0):
    # New bytes of stdout.txt / stderr.txt since the given offsets, for --follow and the UI.
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    d = Path(jobs[jid]["dir"])
    def read_from(name, off):
        f = d / name
        if not f.exists():
            return "", off
        with f.open("rb") as fh:
            fh.seek(off)
            data = fh.read()
        return data.decode("utf-8", "replace"), off + len(data)
    out, no = read_from("stdout.txt", offset_out)
    err, ne = read_from("stderr.txt", offset_err)
    return {"status": jobs[jid]["status"], "stdout": out, "stderr": err, "offset_out": no, "offset_err": ne}


UI_HTML = r"""<!doctype html><meta charset="utf-8"><title>colab-harness</title>
<style>body{font:13px/1.4 ui-monospace,Menlo,monospace;margin:0;background:#111;color:#ddd;display:grid;grid-template-columns:280px 1fr;height:100vh}
aside{padding:12px;border-right:1px solid #333;overflow:auto}main{padding:12px;overflow:auto}h1{font-size:14px;margin:0 0 8px}
.k{color:#888}.j{padding:4px 6px;border-radius:4px;cursor:pointer;display:flex;gap:8px}.j:hover,.j.sel{background:#222}
.s-running{color:#fc6}.s-done{color:#6c6}.s-failed{color:#f66}.s-queued{color:#69f}pre{white-space:pre-wrap;background:#181818;padding:8px;border-radius:4px;min-height:200px}
button{background:#333;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px 8px;cursor:pointer}input{background:#181818;color:#ddd;border:1px solid #555;border-radius:4px;padding:4px;width:100%}</style>
<aside><h1>colab-harness</h1><div id=auth><input id=tok placeholder="paste HARNESS token once" type=password><button onclick="setTok()">save</button></div>
<div id=health class=k>connecting…</div><div style="margin:8px 0"><button onclick="act('/lease',{minutes:120})">keep 2h</button> <button onclick="if(confirm('release the runtime?'))act('/shutdown',{stop_vllm:true})">release</button></div><h1>jobs</h1><div id=jobs></div></aside>
<main><div id=title class=k>select a job</div><pre id=log></pre></main>
<script>
const T=()=>localStorage.getItem('harness_token');function setTok(){localStorage.setItem('harness_token',document.getElementById('tok').value.trim());document.getElementById('auth').hidden=true;tick()}
if(T())document.getElementById('auth').hidden=true;
const H=()=>({authorization:'Bearer '+T()});let sel=null,off={o:0,e:0},last='';
async function get(p){const r=await fetch(p,{headers:H()});if(r.status===401){localStorage.removeItem('harness_token');document.getElementById('auth').hidden=false;throw new Error('401')}return r.json()}
async function act(p,b){await fetch(p,{method:'POST',headers:{...H(),'content-type':'application/json'},body:JSON.stringify(b)});tick()}
function pick(id){sel=id;off={o:0,e:0};document.getElementById('log').textContent='';document.getElementById('title').textContent=id;tick()}
async function tick(){try{const h=await get('/health');const L=h.lease;document.getElementById('health').innerHTML=`gpu <b>${h.gpu.name||'-'}</b> ${h.gpu.memory_used||''}<br>lease <b>${Math.max(0,Math.floor(L.expires_in_s/60))} min</b>${L.busy?' (busy)':''}${L.shutdown?' · <span class=s-failed>releasing</span>':''}<br>vllm <b>${h.vllm.model||'-'}</b>${h.vllm.ready?' ready':h.vllm.running?' loading':''}<br>up ${Math.floor(h.uptime_s/60)} min`;
const js=await get('/jobs');document.getElementById('jobs').innerHTML=js.slice().reverse().map(j=>`<div class="j ${j.id===sel?'sel':''}" onclick="pick('${j.id}')"><span class="s-${j.status}">●</span><span>${j.kind}</span><span class=k>${j.id.slice(9,15)}</span><span class=k>${j.finished?Math.round(j.finished-j.started)+'s':j.started?Math.round(Date.now()/1000-j.started)+'s…':''}</span></div>`).join('');
if(sel){const t=await get(`/jobs/${sel}/tail?offset_out=${off.o}&offset_err=${off.e}`);off={o:t.offset_out,e:t.offset_err};const el=document.getElementById('log');if(t.stdout||t.stderr){el.textContent+=t.stdout+(t.stderr?'\n[stderr] '+t.stderr:'');el.scrollTop=el.scrollHeight}
const j=js.find(x=>x.id===sel);if(j&&j.status!==last){last=j.status;if(j.status==='failed')el.textContent+='\n✗ '+j.error;if(j.status==='done')el.textContent+='\n✓ '+JSON.stringify(j.result)}}}catch(e){if(e.message!=='401')document.getElementById('health').textContent='unreachable: '+e.message}}
tick();setInterval(tick,3000);
</script>"""


def run_shell(job: dict) -> dict:
    cmd = job["params"].get("cmd")
    if not cmd:
        raise ValueError("shell job needs params.cmd")
    timeout = int(job["params"].get("timeout", 600))
    with (Path(job["dir"]) / "stdout.txt").open("w") as out, (Path(job["dir"]) / "stderr.txt").open("w") as err:
        proc = subprocess.run(cmd, shell=True, stdout=out, stderr=err, text=True, timeout=timeout, cwd=job["dir"])
    so, se = (Path(job["dir"]) / "stdout.txt").read_text(), (Path(job["dir"]) / "stderr.txt").read_text()
    return {"exit_code": proc.returncode, "stdout_tail": so[-2000:], "stderr_tail": se[-2000:]}


COOKIE_ERROR_PATTERNS = ["sign in", "login required", "cookies", "age-restricted", "private video",
                         "confirm your age", "bot", "captcha", "not a bot"]


def run_youtube(job: dict) -> dict:
    # Ported from the jianglens YouTube_Manager: bestaudio → wav via ffmpeg, mono 16 kHz.
    # An uploaded cookies.txt (Netscape) is used for this job only and deleted after.
    p = job["params"]
    url = p.get("url")
    if not url:
        raise ValueError("youtube job needs params.url")
    d = Path(job["dir"])
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "yt-dlp"], check=True)
    # YouTube serves JS challenges ("The page needs to be reloaded"); yt-dlp solves
    # them with a JS runtime plus its remote challenge-solver components (jianglens
    # used the same: deno + ejs:github). Install deno once per runtime.
    deno_bin = Path.home() / ".deno" / "bin"
    if not (deno_bin / "deno").exists():
        subprocess.run(["bash", "-c", "curl -fsSL https://deno.land/install.sh | sh -s -- -y >/dev/null 2>&1"], check=False, timeout=300)
    env = dict(os.environ, PATH=f"{deno_bin}:{os.environ.get('PATH', '')}")
    cookies = d / job["input"] if "input" in job else None
    cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist", "-f", "bestaudio/best", "-x", "--audio-format", "wav",
           "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000", "--write-info-json", "--no-write-playlist-metafiles",
           "-o", str(d / "audio.%(ext)s"), "--quiet", "--no-warnings", "--retries", "3", "--extractor-retries", "3"]
    if (deno_bin / "deno").exists():
        cmd += ["--js-runtimes", "deno", "--remote-components", "ejs:github"]
    cmd.append(url)
    if cookies:
        cmd += ["--cookies", str(cookies)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=int(p.get("timeout", 3600)), env=env)
        if proc.returncode != 0 and "needs to be reloaded" in (proc.stderr + proc.stdout):
            time.sleep(3)   # transient challenge page: one retry
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=int(p.get("timeout", 3600)), env=env)
    finally:
        if cookies:
            cookies.unlink(missing_ok=True)
            job.pop("input", None)
    (d / "yt-dlp.log").write_text(proc.stdout + proc.stderr)
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout)[-800:]
        if any(k in msg.lower() for k in COOKIE_ERROR_PATTERNS):
            raise RuntimeError("COOKIE_EXPIRED: YouTube refused the download (" + msg.strip().splitlines()[-1][:200] +
                               "). Re-export cookies.txt from a logged-in browser and seed it locally.")
        raise RuntimeError(f"yt-dlp exit {proc.returncode}: {msg.strip()[-400:]}")
    info = next(iter(d.glob("*.info.json")), None)
    meta = {}
    if info:
        raw = json.loads(info.read_text())
        meta = {k: raw.get(k) for k in ("id", "title", "channel", "channel_id", "uploader", "upload_date", "duration",
                                        "webpage_url", "view_count", "language")}
        (d / "metadata.youtube.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        info.unlink()
    wav = d / "audio.wav"
    if not wav.exists():
        raise RuntimeError("download finished but audio.wav is missing; see yt-dlp.log")
    return {"title": meta.get("title"), "duration": meta.get("duration"), "audio_bytes": wav.stat().st_size,
            "cookies_used": cookies is not None}


# ---- diarize kind: pyannote in its own venv (Colab's torchaudio mismatches its torch) ----
PYANNOTE_VENV = Path(os.environ.get("HARNESS_PYANNOTE_VENV", "/content/pyannote-venv"))
PYANNOTE_WORKER = r"""
import json, os, sys
from pathlib import Path
import torch, torchaudio
from pyannote.audio import Pipeline
from pyannote.core import Annotation, Segment
src, out_dir, pipeline_id, threshold = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], float(sys.argv[4])
num_speakers = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else None
token = os.environ.get("HF_TOKEN") or None
pipeline = Pipeline.from_pretrained(pipeline_id, token=token)
if pipeline is None:
    raise SystemExit(f"could not load {pipeline_id}: accept its terms on huggingface.co and set HF_TOKEN")
pipeline.to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))
waveform, sr = torchaudio.load(str(src))
out = pipeline({"waveform": waveform, "sample_rate": sr}, num_speakers=num_speakers)
ann = getattr(out, "speaker_diarization", None) or getattr(out, "annotation", None) or out
def serialize(a):
    return {"diarization": [{"speaker": lab, "start": round(s.start, 3), "end": round(s.end, 3), "track": t}
                            for s, t, lab in a.itertracks(yield_label=True)], "embeddings": {}}
def group(a, th):
    g = Annotation(); cs, cg = None, None
    for s, t, lab in a.itertracks(yield_label=True):
        if cs is None: cs, cg = lab, s; continue
        if cs == lab and s.start - cg.end <= th: cg = Segment(cg.start, s.end)
        else: g[cg] = cs; cs, cg = lab, s
    if cs is not None: g[cg] = cs
    return g
(out_dir / "dump.json").write_text(json.dumps(serialize(ann), indent=2))
(out_dir / "grouped.json").write_text(json.dumps(serialize(group(ann, threshold)), indent=2))
speakers = sorted({lab for _, _, lab in ann.itertracks(yield_label=True)})
print(json.dumps({"speakers": speakers, "turns": len(list(ann.itertracks()))}))
"""


def pyannote_installed() -> bool:
    return (PYANNOTE_VENV / "bin" / "python").exists() and any(PYANNOTE_VENV.glob("lib/python*/site-packages/pyannote/audio/__init__.py"))


def run_diarize(job: dict) -> dict:
    p = job["params"]
    if "input" not in job:
        raise ValueError("diarize job needs an audio file (upload or input_job)")
    d = Path(job["dir"])
    if not pyannote_installed():
        subprocess.run(["bash", "-c", f"pip install -q uv && rm -rf {PYANNOTE_VENV} && uv venv -q {PYANNOTE_VENV} && "
                        f"uv pip install -q --python {PYANNOTE_VENV}/bin/python 'pyannote.audio>=3.3' torchaudio"], check=True, timeout=1800)
    worker = d / "pyannote_worker.py"
    worker.write_text(PYANNOTE_WORKER)
    args = [str(PYANNOTE_VENV / "bin" / "python"), str(worker), str(d / job["input"]), str(d),
            p.get("pipeline", "pyannote/speaker-diarization-3.1"), str(p.get("group_threshold", 3.0)), str(p.get("num_speakers") or "")]
    # Colab's kernel exports MPLBACKEND=module://matplotlib_inline...; the venv's matplotlib rejects it.
    env = dict(os.environ, MPLBACKEND="Agg")
    proc = subprocess.run(args, capture_output=True, text=True, timeout=int(p.get("timeout", 7200)), env=env)
    (d / "diarize.log").write_text(proc.stdout + proc.stderr)
    worker.unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(f"pyannote exit {proc.returncode}: {(proc.stderr or proc.stdout).strip()[-600:]}")
    last = [l for l in proc.stdout.splitlines() if l.startswith("{")]
    return json.loads(last[-1]) if last else {"ok": True}


def find_speaker(seg_start, seg_end, turns):
    # jianglens rule: the speaker with the largest time overlap, else None
    best, best_ov = None, 0.0
    for t in turns:
        ov = min(seg_end, t["end"]) - max(seg_start, t["start"])
        if ov > best_ov:
            best, best_ov = t["speaker"], ov
    return best


def run_transcribe(job: dict) -> dict:
    # Ported from the Whisper_Transcription notebook: whole-file transcription with
    # faster-whisper; the model is cached per (name, compute_type) for the session.
    from faster_whisper import WhisperModel  # lazy: heavy import
    p = job["params"]
    if "input" not in job:
        raise ValueError("transcribe job needs an uploaded audio file")
    model_name = p.get("model", "large-v3")
    device = os.environ.get("HARNESS_DEVICE", "cuda")
    compute = p.get("compute_type") or ("float16" if device == "cuda" else "int8")
    key = (model_name, compute)
    if key not in _models:
        _models[key] = WhisperModel(model_name, device=device, compute_type=compute)
    model = _models[key]
    src = Path(job["dir"]) / job["input"]
    segments, info = model.transcribe(
        str(src), language=p.get("language") or None, beam_size=int(p.get("beam_size", 5)),
        vad_filter=bool(p.get("vad_filter", True)), word_timestamps=bool(p.get("word_timestamps", False)),
    )
    turns = None
    if p.get("diarization_job"):
        gdir = Path(jobs.get(str(p["diarization_job"]), {}).get("dir", ""))
        gpath = gdir / "grouped.json"
        if not gpath.is_file():
            raise ValueError(f"diarization_job {p['diarization_job']} has no grouped.json")
        turns = json.loads(gpath.read_text())["diarization"]
    segs = []
    for s in segments:
        seg = {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        if turns is not None:
            seg["speaker"] = find_speaker(seg["start"], seg["end"], turns)
        if p.get("word_timestamps") and s.words:
            seg["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word} for w in s.words]
        segs.append(seg)
    out = {"model": model_name, "compute_type": compute, "language": info.language,
           "language_probability": round(info.language_probability, 3), "duration": round(info.duration, 3),
           "segments": segs}
    (Path(job["dir"]) / "transcription.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    md = "\n".join(f"[{fmt(s['start'])} → {fmt(s['end'])}]{' ' + s['speaker'] + ':' if s.get('speaker') else ''} {s['text']}" for s in segs)
    (Path(job["dir"]) / "transcript.md").write_text(md + "\n")
    return {"language": info.language, "duration": out["duration"], "segments": len(segs),
            "speakers": sorted({x["speaker"] for x in segs if x.get("speaker")}) if turns is not None else None}


def fmt(t: float) -> str:
    h, r = divmod(int(t), 3600)
    m, s = divmod(r, 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


def run_script(job: dict) -> dict:
    # An uploaded .py (or .sh) runs in the job dir with params.args and params.env,
    # stdout/stderr captured to files, so training and DSPy compiles ship as one file
    # plus whatever they download. A python venv can be selected with params.python.
    if "input" not in job:
        raise ValueError("script job needs an uploaded script file")
    p = job["params"]
    src = Path(job["dir"]) / job["input"]
    py = p.get("python") or sys.executable
    cmd = ([py, str(src)] if src.suffix == ".py" else ["bash", str(src)]) + [str(a) for a in p.get("args", [])]
    env = dict(os.environ, **{str(k): str(v) for k, v in (p.get("env") or {}).items()})
    env.setdefault("HARNESS_JOB_DIR", job["dir"])
    env.setdefault("HARNESS_TOKEN", TOKEN)
    env.setdefault("VLLM_BASE_URL", f"http://127.0.0.1:{VLLM_PORT}/v1")
    timeout = int(p.get("timeout", 6 * 3600))
    with (Path(job["dir"]) / "stdout.txt").open("w") as out, (Path(job["dir"]) / "stderr.txt").open("w") as err:
        proc = subprocess.run(cmd, cwd=job["dir"], env=env, stdout=out, stderr=err, timeout=timeout)
    tail = lambda n: (Path(job["dir"]) / n).read_text()[-2000:]
    if proc.returncode != 0:
        raise RuntimeError(f"exit {proc.returncode}: {tail('stderr.txt').strip()[-500:]}")
    result = {"exit_code": proc.returncode, "stdout_tail": tail("stdout.txt"), "stderr_tail": tail("stderr.txt")}
    if p.get("push"):
        result["push"] = hf_push(job, str(p["push"]), str(p.get("push_dir") or "adapter"), private=not bool(p.get("public")))
    return result


KINDS = {"shell": run_shell, "transcribe": run_transcribe, "script": run_script, "youtube": run_youtube, "diarize": run_diarize}


def worker():
    while True:
        jid = queue.get()
        job = jobs[jid]
        job["status"], job["started"] = "running", time.time()
        try:
            job["result"] = KINDS[job["kind"]](job)
            job["status"] = "done"
        except Exception as e:  # noqa: BLE001
            job["status"], job["error"] = "failed", f"{type(e).__name__}: {e}"
        job["finished"] = time.time()


threading.Thread(target=worker, daemon=True).start()


# ---------------- vLLM ----------------
def vllm_installed() -> bool:
    # A venv directory alone is not an install: a failed build leaves bin/python behind.
    py = VLLM_VENV / "bin" / "python"
    return py.exists() and any(VLLM_VENV.glob("lib/python*/site-packages/vllm/__init__.py"))


def vllm_status() -> dict:
    proc = _vllm["proc"]
    alive = proc is not None and proc.poll() is None
    ready = False
    if alive:
        try:
            ready = httpx.get(f"http://127.0.0.1:{VLLM_PORT}/health", timeout=2).status_code == 200
        except Exception:  # noqa: BLE001
            ready = False
    return {"running": alive, "ready": ready, "model": _vllm["model"] if alive else None,
            "exit_code": None if alive or proc is None else proc.returncode,
            "installed": vllm_installed()}


@app.post("/vllm/start")
def vllm_start(body: dict):
    if vllm_status()["running"]:
        raise HTTPException(409, f"vllm already running with {_vllm['model']}; stop it first")
    model = body.get("model")
    if not model:
        raise HTTPException(400, "body.model required")
    extra = body.get("args", [])
    # vLLM pins its own torch; installing it into Colab's interpreter breaks the
    # torch/torchaudio CUDA pairing there. It lives in its own venv instead.
    py = VLLM_VENV / "bin" / "python"
    if not vllm_installed():
        raise HTTPException(409, f"vllm venv missing at {VLLM_VENV}; create it with a shell job: "
                                 f"pip install -q uv && uv venv {VLLM_VENV} && uv pip install --python {VLLM_VENV}/bin/python vllm ninja")
    cmd = [str(py), "-m", "vllm.entrypoints.openai.api_server", "--model", model, "--port", str(VLLM_PORT),
           "--host", "127.0.0.1", "--api-key", TOKEN, "--gpu-memory-utilization", str(body.get("gpu_memory_utilization", 0.9))]
    if body.get("max_model_len"):
        cmd += ["--max-model-len", str(body["max_model_len"])]
    cmd += [str(a) for a in extra]
    log = open(_vllm["log"], "w")  # noqa: SIM115
    # The venv's bin must lead PATH: vLLM JIT-compiles sampler kernels with ninja.
    env = dict(os.environ, PATH=f"{VLLM_VENV / 'bin'}:{os.environ.get('PATH', '')}")
    _vllm["proc"] = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT, env=env)
    _vllm["model"], _vllm["started"] = model, time.time()
    shown = [("<token>" if a == TOKEN else a) for a in cmd]   # never echo the session token
    return {"started": True, "model": model, "cmd": shown}


@app.post("/vllm/stop")
def vllm_stop():
    proc = _vllm["proc"]
    if proc is None or proc.poll() is not None:
        return {"stopped": False, "reason": "not running"}
    proc.terminate()
    try:
        proc.wait(15)
    except subprocess.TimeoutExpired:
        proc.kill()
    return {"stopped": True}


@app.get("/vllm/status")
def vllm_status_route():
    st = vllm_status()
    log = _vllm["log"]
    st["log_tail"] = log.read_text()[-3000:] if log.exists() else ""
    return st


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def vllm_proxy(path: str, request: Request):
    # Same-tunnel reverse proxy to vLLM's OpenAI-compatible API, streaming intact.
    if not vllm_status()["ready"]:
        raise HTTPException(503, "vllm is not ready")
    url = f"http://127.0.0.1:{VLLM_PORT}/v1/{path}"
    headers = {"authorization": f"Bearer {TOKEN}", "content-type": request.headers.get("content-type", "application/json")}
    body = await request.body()
    client = httpx.AsyncClient(timeout=None)
    req = client.build_request(request.method, url, headers=headers, content=body, params=request.query_params)
    upstream = await client.send(req, stream=True)

    async def gen():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()
    return StreamingResponse(gen(), status_code=upstream.status_code,
                             media_type=upstream.headers.get("content-type"))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
