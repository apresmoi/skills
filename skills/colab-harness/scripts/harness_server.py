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


@app.get("/health")
def health():
    return {
        "ok": True, "uptime_s": int(time.time() - STARTED), "gpu": gpu_info(),
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
    out["files"] = sorted(p.name for p in d.iterdir() if p.is_file()) if d.exists() else []
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


@app.get("/jobs/{jid}/files/{name}")
def get_file(jid: str, name: str):
    if jid not in jobs:
        raise HTTPException(404, "no such job")
    p = (Path(jobs[jid]["dir"]) / name).resolve()
    if not p.is_file() or Path(jobs[jid]["dir"]).resolve() not in p.parents:
        raise HTTPException(404, "no such file")
    return FileResponse(p)


def run_shell(job: dict) -> dict:
    cmd = job["params"].get("cmd")
    if not cmd:
        raise ValueError("shell job needs params.cmd")
    timeout = int(job["params"].get("timeout", 600))
    proc = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout, cwd=job["dir"])
    (Path(job["dir"]) / "stdout.txt").write_text(proc.stdout)
    (Path(job["dir"]) / "stderr.txt").write_text(proc.stderr)
    return {"exit_code": proc.returncode, "stdout_tail": proc.stdout[-2000:], "stderr_tail": proc.stderr[-2000:]}


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
    segs = []
    for s in segments:
        seg = {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
        if p.get("word_timestamps") and s.words:
            seg["words"] = [{"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word} for w in s.words]
        segs.append(seg)
    out = {"model": model_name, "compute_type": compute, "language": info.language,
           "language_probability": round(info.language_probability, 3), "duration": round(info.duration, 3),
           "segments": segs}
    (Path(job["dir"]) / "transcription.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    md = "\n".join(f"[{fmt(s['start'])} → {fmt(s['end'])}] {s['text']}" for s in segs)
    (Path(job["dir"]) / "transcript.md").write_text(md + "\n")
    return {"language": info.language, "duration": out["duration"], "segments": len(segs)}


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
    return {"exit_code": proc.returncode, "stdout_tail": tail("stdout.txt"), "stderr_tail": tail("stderr.txt")}


KINDS = {"shell": run_shell, "transcribe": run_transcribe, "script": run_script}


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
            "installed": (VLLM_VENV / "bin" / "python").exists()}


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
    if not py.exists():
        raise HTTPException(409, f"vllm venv missing at {VLLM_VENV}; create it with a shell job: "
                                 f"python -m venv {VLLM_VENV} && {VLLM_VENV}/bin/pip install -q vllm")
    cmd = [str(py), "-m", "vllm.entrypoints.openai.api_server", "--model", model, "--port", str(VLLM_PORT),
           "--host", "127.0.0.1", "--api-key", TOKEN, "--gpu-memory-utilization", str(body.get("gpu_memory_utilization", 0.9))]
    if body.get("max_model_len"):
        cmd += ["--max-model-len", str(body["max_model_len"])]
    cmd += [str(a) for a in extra]
    log = open(_vllm["log"], "w")  # noqa: SIM115
    _vllm["proc"] = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
    _vllm["model"], _vllm["started"] = model, time.time()
    return {"started": True, "model": model, "cmd": cmd}


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
