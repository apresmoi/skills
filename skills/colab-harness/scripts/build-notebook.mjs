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
**Runtime → Run all**. The last cell prints one line to paste locally:

\`\`\`
node colab.mjs connect <url> <token>
\`\`\`

Keep this tab open: the final cell loops to keep the session alive. Close it
(or Runtime → Disconnect) to end the session. The server binds to loopback and
is reached only through the tunnel; every request needs the printed token.
`),
  code(`#@title 1) Config
MOUNT_DRIVE = True  #@param {type:"boolean"}
#@markdown Mount Google Drive so model caches persist across sessions (recommended).
DRIVE_CACHE_DIR = "colab-harness"  #@param {type:"string"}
#@markdown Folder under MyDrive for the HuggingFace cache and job archive.
HARNESS_PORT = 8787

import os, secrets
from pathlib import Path
HARNESS_TOKEN = secrets.token_urlsafe(24)
if MOUNT_DRIVE:
    from google.colab import drive
    drive.mount("/content/drive")
    cache = Path("/content/drive/MyDrive") / DRIVE_CACHE_DIR
    (cache / "_hf_home").mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache / "_hf_home")
    print("HF_HOME ->", os.environ["HF_HOME"])
print("token generated (printed with the tunnel URL in the last cell)")
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
print("\\nPaste this on your machine:\\n")
print(f"  node colab.mjs connect {url} {HARNESS_TOKEN}\\n")
`),
  code(`#@title 5) Keep alive (leave running)
import time, urllib.request, json
while True:
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{HARNESS_PORT}/health", headers={"Authorization": f"Bearer {HARNESS_TOKEN}"})
        h = json.loads(urllib.request.urlopen(req, timeout=5).read())
        print(time.strftime("%H:%M:%S"), "up", h["uptime_s"], "s · jobs", h["jobs"], "· vllm", h["vllm"]["model"] or "-", "· gpu", h["gpu"].get("memory_used", "?"))
    except Exception as e:
        print(time.strftime("%H:%M:%S"), "health check failed:", e)
    time.sleep(300)
`),
];

const nb = {
  nbformat: 4, nbformat_minor: 5,
  metadata: { colab: { name: "Colab_Harness.ipynb", provenance: [] }, kernelspec: { name: "python3", display_name: "Python 3" }, accelerator: "GPU" },
  cells,
};
writeFileSync(path.join(here, "..", "Colab_Harness.ipynb"), JSON.stringify(nb, null, 1) + "\n");
console.log("wrote Colab_Harness.ipynb with", cells.length, "cells");
