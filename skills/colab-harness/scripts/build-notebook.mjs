#!/usr/bin/env node
// Generates Colab_Harness.ipynb from harness_server.py so the notebook and the
// server never drift. Run after editing the server:  node scripts/build-notebook.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = readFileSync(path.join(here, "harness_server.py"), "utf8");

const md = (text) => ({ cell_type: "markdown", metadata: {}, source: text });
const code = (text) => ({ cell_type: "code", metadata: {}, execution_count: null, outputs: [], source: text });

const cells = [
  md(`# colab-harness

Turns this Colab runtime into a job server reachable from your machine. Pick a
**GPU runtime** first (Runtime → Change runtime type → L4 or T4), then
**Runtime → Run all**. The tunnel cell prints one line to run locally:

\`\`\`
node colab.mjs connect <url>
\`\`\`

One-time setup: run \`node colab.mjs init\` locally, copy the token it stores
(\`pbcopy < ~/.colab-harness/token\`), and add it in the 🔑 Secrets panel as
\`HARNESS_TOKEN\` with notebook access on. The token is then never printed.

Keep this tab open: the final cell is the lease watchdog. It unassigns the
runtime when the local side has been idle for 30 minutes or after
\`node colab.mjs release\`. The server binds to loopback and is reached only
through the tunnel; every request needs the shared token.
`),
  code(`#@title 1) Config
MOUNT_DRIVE = False  #@param {type:"boolean"}
#@markdown Mount Google Drive for model caches (needs a consent click every runtime; leave off for unattended starts).
DRIVE_CACHE_DIR = "colab-harness"  #@param {type:"string"}
#@markdown Folder under MyDrive for the HuggingFace cache and job archive.
HARNESS_PORT = 8787

import os, secrets
from pathlib import Path
# The token comes from Colab Secrets (🔑 panel, name HARNESS_TOKEN, notebook access ON),
# generated locally by  node colab.mjs init  and pasted there once. It is then never
# printed. Without the secret, a one-off token is generated and printed as a fallback.
TOKEN_FROM_SECRET = False
try:
    from google.colab import userdata
    HARNESS_TOKEN = userdata.get("HARNESS_TOKEN")
    TOKEN_FROM_SECRET = bool(HARNESS_TOKEN)
except Exception:
    HARNESS_TOKEN = None
if not HARNESS_TOKEN:
    HARNESS_TOKEN = secrets.token_urlsafe(24)
if MOUNT_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    cache = Path("/content/drive/MyDrive") / DRIVE_CACHE_DIR
    (cache / "_hf_home").mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache / "_hf_home")
    print("HF_HOME ->", os.environ["HF_HOME"])
print("token: from Colab secret HARNESS_TOKEN" if TOKEN_FROM_SECRET else "token: generated for this session (no HARNESS_TOKEN secret set; it will be printed with the URL)")
`),
  code(`#@title 2) Install dependencies
import subprocess, sys
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "fastapi", "uvicorn", "httpx", "python-multipart", "faster-whisper"], check=True)
subprocess.run(["bash", "-c", "curl -fsSL -o /usr/local/bin/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x /usr/local/bin/cloudflared"], check=True)
print(subprocess.run(["cloudflared", "--version"], capture_output=True, text=True).stdout.strip())
print(subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip() or "no GPU (pick a GPU runtime)")
`),
  code(`#@title 3) Write and start the job server
from pathlib import Path
import os, subprocess, time, urllib.request
SERVER_SRC = r'''${server.replace(/'''/g, "\\'\\'\\'")}'''
Path("/content/harness_server.py").write_text(SERVER_SRC)
env = dict(os.environ, HARNESS_TOKEN=HARNESS_TOKEN, HARNESS_PORT=str(HARNESS_PORT), HARNESS_ROOT="/content/harness")
try:
    from google.colab import userdata
    _hf = userdata.get("HF_TOKEN")
    if _hf:
        env["HF_TOKEN"] = _hf; print("HF_TOKEN: passed to the server (gated models OK)")
except Exception:
    print("HF_TOKEN: not set; gated Hugging Face models will fail to download")
server_log = open("/content/harness_server.log", "w")
server_proc = subprocess.Popen([sys.executable, "/content/harness_server.py"], env=env, stdout=server_log, stderr=subprocess.STDOUT)
for _ in range(60):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{HARNESS_PORT}/health", headers={"Authorization": f"Bearer {HARNESS_TOKEN}"})
        print(urllib.request.urlopen(req, timeout=2).read().decode()[:300]); break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("server did not come up; see /content/harness_server.log")
`),
  code(`#@title 4) Open the tunnel and print the connect line
import re, subprocess, time
tunnel_log = open("/content/cloudflared.log", "w")
tunnel_proc = subprocess.Popen(["cloudflared", "tunnel", "--url", f"http://127.0.0.1:{HARNESS_PORT}", "--no-autoupdate"], stdout=tunnel_log, stderr=subprocess.STDOUT)
url = None
for _ in range(60):
    m = re.search(r"https://[a-z0-9-]+\\.trycloudflare\\.com", open("/content/cloudflared.log").read())
    if m:
        url = m.group(0); break
    time.sleep(1)
if not url:
    raise SystemExit("no tunnel URL yet; see /content/cloudflared.log")
# Publish the URL to a private Hugging Face dataset repo (<user>/colab-harness-state) so the
# local CLI can find it with a bare  node colab.mjs connect  and nobody copies URLs by hand.
STATE_REPO, STATE_FILE = None, None
try:
    if env.get("HF_TOKEN"):
        from huggingface_hub import HfApi
        import json as _json
        _api = HfApi(token=env["HF_TOKEN"]); _me = _api.whoami()["name"]
        STATE_REPO = f"{_me}/colab-harness-state"
        _api.create_repo(STATE_REPO, repo_type="dataset", private=True, exist_ok=True)
        _gpu = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip() or "cpu"
        STATE_FILE = f"runtimes/{int(time.time())}.json"
        _rec = {"url": url, "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "gpu": _gpu, "token_from_secret": TOKEN_FROM_SECRET}
        _api.upload_file(path_or_fileobj=_json.dumps(_rec).encode(), path_in_repo=STATE_FILE, repo_id=STATE_REPO, repo_type="dataset", commit_message="runtime up")
except Exception as _e:
    STATE_REPO = None
    print("could not publish the URL to Hugging Face (copy it by hand):", str(_e)[:160])
print("\\nOn your machine:\\n")
if STATE_REPO and TOKEN_FROM_SECRET:
    print(f"  node colab.mjs connect            # URL published to {STATE_REPO} (private); no copying needed")
    print(f"  node colab.mjs connect {url}      # or explicitly\\n")
elif TOKEN_FROM_SECRET:
    print(f"  node colab.mjs connect {url}\\n")
else:
    print(f"  node colab.mjs connect {url} {HARNESS_TOKEN}\\n")
`),
  code(`#@title 5) Keep alive, lease watchdog (leave running)
#@markdown Loops while the local side holds a lease. When the lease expires with
#@markdown no job running, or after \`colab.mjs release\`, the runtime is unassigned
#@markdown so a forgotten session stops burning compute units.
import time, urllib.request, json
def _get(path):
    req = urllib.request.Request(f"http://127.0.0.1:{HARNESS_PORT}{path}", headers={"Authorization": f"Bearer {HARNESS_TOKEN}"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read())
while True:
    try:
        h = _get("/health"); L = h["lease"]
        print(time.strftime("%H:%M:%S"), f"lease {L['expires_in_s']//60:>3} min · jobs {h['jobs']} · vllm {h['vllm']['model'] or '-'} · gpu {h['gpu'].get('memory_used','?')}")
        if L["should_shutdown"]:
            print("lease expired with nothing running" if not L["shutdown"] else "release requested", "→ unassigning runtime")
            try:
                if STATE_REPO and STATE_FILE:
                    from huggingface_hub import HfApi
                    HfApi(token=env["HF_TOKEN"]).delete_file(STATE_FILE, repo_id=STATE_REPO, repo_type="dataset", commit_message="runtime down")
            except Exception as _e:
                print("could not retire the published URL:", str(_e)[:120])
            from google.colab import runtime
            runtime.unassign()
            break
    except Exception as e:
        print(time.strftime("%H:%M:%S"), "health check failed:", e)
    time.sleep(60)
`),
];

const nb = {
  nbformat: 4, nbformat_minor: 5,
  metadata: { colab: { name: "Colab_Harness.ipynb", provenance: [] }, kernelspec: { name: "python3", display_name: "Python 3" }, accelerator: "GPU" },
  cells,
};
writeFileSync(path.join(here, "..", "Colab_Harness.ipynb"), JSON.stringify(nb, null, 1) + "\n");
console.log("wrote Colab_Harness.ipynb with", cells.length, "cells");
