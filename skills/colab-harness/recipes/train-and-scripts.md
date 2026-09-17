# Scripts on the VM: LoRA training, DSPy compile, anything

The `script` kind uploads one `.py` or `.sh`, runs it in a job directory on
the VM, streams nothing back until it ends, then fetches whatever it wrote.

```bash
node colab.mjs script my_job.py [--args "--epochs 1 --lr 2e-4"] [--env K=V,K2=V2] [--python /content/vllm-venv/bin/python] [--out DIR] [--all] [--push REPO [--push-dir adapter] [--public]]
```

The script sees `HARNESS_JOB_DIR` (write outputs here), `HARNESS_TOKEN`,
`VLLM_BASE_URL`, and `HF_TOKEN` when the secret exists. Exit non-zero to
fail the job; stdout/stderr come back as `stdout.txt` / `stderr.txt`.
Directories are fetched recursively; `checkpoint-*` folders are skipped
unless `--all`. Default timeout 6 h (`--timeout` seconds).

## LoRA fine-tune: `examples/train_lora.py`

```bash
node colab.mjs script examples/train_lora.py --args "--model Qwen/Qwen2.5-0.5B-Instruct --dataset yahma/alpaca-cleaned --samples 300 --steps 60"
```

TRL + PEFT, bf16, rank 16. Writes `adapter/`, checkpoints every 20 steps,
`train_log.json`, prints a `SUMMARY` line and a sample generation, ends with
`=== TRAIN COMPLETE ===`. Resumes from a checkpoint if the job dir has one.
Measured: 60 steps on 300 rows in 53 s on an L4, loss 2.29 → 1.08, adapter
35 MB fetched. Removes Colab's incompatible `torchao` first; that is
expected output, not an error.

Sizing on the L4: QLoRA up to about 14B, LoRA bf16 up to about 4B. A 12B
QLoRA on 10k examples is 3 to 6 hours, 5 to 9 compute units.

## Keeping the result: push to a private Hugging Face repo

Nothing on the VM survives `release`, and the tunnel caps uploads at
100 MB, so the durable home for a trained adapter is the hub, pushed from
the VM itself:

```bash
node colab.mjs script examples/train_lora.py --args "..." --push my-adapter
```

- `--push REPO` uploads `adapter/` from the job dir when the script exits 0.
  A bare name becomes `<hf-user>/<name>`. The repo is created **private**;
  an existing public repo of that name is refused unless `--public` is given.
- `--push-dir DIR` pushes another folder (a `merged/` model, a DSPy
  `compiled/` folder). Only that folder is pushed, never the checkpoints.
- Before submitting, the CLI checks the VM's token can write; a read-only
  `HF_TOKEN` fails fast with the fix (see `recipes/setup-hf.md`). The push
  result prints the file count, size, and URL, marked `[private]`.
- A README with `base_model` and `library_name: peft` is added when the
  folder has none, so the hub page and vLLM know the lineage.

Only the adapter goes up: rank 16 on all linear layers is about 18 MB for
a 0.5B base, 85 MB for an 8B, 130 MB for a 12B. The base model is
re-downloaded wherever the adapter is used.

## The catalog: remembering what you trained

Every `script` job that pushes, or that writes an `adapter/` folder, adds an
entry to `~/.colab-harness/catalog.json`. Give it a name and a description at
submit time; the owner project is detected from where you run the command:

```bash
cd ~/code/glyphbench
node colab.mjs script examples/train_lora.py --args "..." \
  --push glyph-router --description "routes glyph prompts to solvers, v1" --tags glyphbench,router
```

An entry records: `name`, `description`, `tags`, `owner` (cwd, git root,
`origin` remote, branch, commit, dirty flag), `hub` (repo, URL, private,
commit, size), `local` (where the files were fetched), `job` (id, session,
script, args, GPU) and `train` (base model, dataset, samples, steps, first
and last loss, seconds), parsed from the trainer's `SUMMARY` line.

```bash
node colab.mjs models                       # table, newest first, descriptions underneath
node colab.mjs models search glyph          # over name, description, tags, base, dataset, owner, args
node colab.mjs models list --owner glyphbench --base qwen [--json]
node colab.mjs models show glyph-router     # the full entry
node colab.mjs models edit glyph-router --description "..." --tags a,b
node colab.mjs models sync                  # rebuild from the hub after losing the laptop
```

The same metadata rides with the artefact: the push adds a `colab-harness`
tag to the model card, a `## colab-harness` section with the owner project,
the job and the training numbers, and a `colab-harness.json` file. `models
sync` lists your hub repos carrying that tag and fills any entry the local
catalog lacks, so the hub is the durable copy and the laptop file is the
fast one. `sync` needs a local login (`hf auth login`, or `HF_TOKEN`).

### Using it elsewhere (laptop, another GPU box, a later Colab)

```bash
hf auth login                                   # once per machine, same account or one with access
hf download <user>/my-adapter --local-dir ./my-adapter
```

- vLLM: `--enable-lora --lora-modules my=<path or repo>`; on Colab,
  `node colab.mjs vllm start <base> --vllm-args "--enable-lora --lora-modules my=<user>/my-adapter"`.
- Transformers/PEFT: `PeftModel.from_pretrained(base, "<user>/my-adapter")`.
- Resume training: download it into the job dir and load it as the starting
  adapter; the example trainer resumes from `checkpoint-*` only.

## DSPy compile: `examples/dspy_compile.py`

```bash
node colab.mjs vllm start Qwen/Qwen2.5-7B-Instruct-AWQ
node colab.mjs script examples/dspy_compile.py --args "--train 20 --dev 40"
```

BootstrapFewShot on SST-2 sentiment against the VM's own vLLM; prints dev
accuracy before and after, writes `compiled_program.json`, `summary.json`.
Measured: 22 s on an L4 with 4 demos. Swap the signature, metric, and
dataset for a real task; keep `dspy.LM("openai/<model>", api_base=VLLM_BASE_URL, api_key=HARNESS_TOKEN)`.

## What a training run must report

A loss that went down is not a result. Before a run counts, it has to answer: does more
data still help, did it overfit, is it better than doing nothing clever, and is the number
bigger than the noise. `examples/train_report.py` is a single stdlib-only file that collects
these and writes three things next to the job's outputs; `examples/train_lora.py` shows it in use.
Inline it when your job uploads only one script (the harness uploads one file per job).

| File | For |
|---|---|
| `REPORT.html` | reading and sending: verdict cards, ladder and loss charts as inline SVG, tables with intervals. Self-contained — no scripts, no data fetched at open time; `open`/`xdg-open` it straight from disk |
| `REPORT.md` | skimming in a terminal or pasting into an issue; same numbers, ASCII trend |
| `training-report.json` | comparing runs and feeding dashboards; every raw point plus the `verdicts` block |

`script` prints the report's path when a job lands, so the next step is to open it, not to grep a log.

The page uses the dark skin of the Diagram Design style guide (cream ink on near-black paper, one gold
accent, serif headings, mono for anything technical, gridlines behind the marks). Provenance sits in the
eyebrow and the footer: `Report(...).html(tool="colab-harness", source="github.com/apresmoi/skills")` —
change both when you fork it.

- **Train partially, always — the data ladder.** Train a *fresh* adapter on 25%, 50% and 100%
  of the data and score each on the same eval set. The shape is the answer to "should we label
  more": still climbing, flattening, or already noise. Continuing one run instead of restarting
  confounds more data with more steps, so each rung starts from the base model. Cost is roughly
  1.75× a single run for three rungs — cheap next to a labelling budget.
- **Score during training, not only at the end.** Validation every N steps gives the step where
  it stopped improving; keep *that* checkpoint. A validation loss that turns up while the
  training loss keeps falling is overfitting, and it is invisible in end-of-run numbers.
- **Two baselines, every time.** The untrained model, and the trivial predictor (always the
  commonest answer). A metric that does not clear both is not evidence of learning. In one
  observed run the whole apparent gain was the base model failing to emit valid JSON at all.
- **Uncertainty on every rate.** `bootstrap_ci` on the per-example results. On 15 examples the
  95% interval is roughly ±0.2, so a 6-point difference is nothing; the report marks such gains
  as `noise` instead of letting them look like progress.
- **Separate format from content.** "Valid JSON" and "right answer" are different columns.
  Formatting is the first thing fine-tuning fixes and the least interesting.
- **Leakage check.** No id, and no near-duplicate prompt, shared between train and eval. For
  data with time or grouping structure (conversations, users, sessions), split by the group and
  keep a buffer around the boundary, or the eval is measuring memorisation.
- **A ceiling, when the labels come from models or several annotators.** Their agreement with
  each other is the highest score worth chasing; at the ceiling the student is finished.
- **The cost of the run**, so the next curve can be priced against buying more labels.
- **Score the sealed test once**, after the checkpoint is chosen on validation. Everything above
  runs on train/val only.

## Surviving a lost runtime: checkpoint off the VM, resume on restart

Nothing on the VM survives, and Colab can reclaim it mid-run, so a long job needs
its state somewhere else. The hub repo it will push to anyway works: push the
adapter plus a tiny progress file every N steps, and read them back when the job
is told to resume. Two env vars are enough (`node colab.mjs script … --supervise
--resume-env RESUME=1 --env CKPT_REPO=<user>/<repo>,CKPT_STEPS=50`):

```python
CKPT_REPO, CKPT_STEPS = os.environ.get("CKPT_REPO", ""), int(os.environ.get("CKPT_STEPS", 100))
RESUME = os.environ.get("RESUME") == "1"

def save(model, state):                       # every CKPT_STEPS optimizer steps
    model.save_pretrained(ckpt_dir)
    json.dump(state, open(f"{ckpt_dir}/progress.json", "w"))   # step, epoch, index within the epoch
    if CKPT_REPO and os.environ.get("HF_TOKEN"):
        api = HfApi(token=os.environ["HF_TOKEN"])
        api.create_repo(CKPT_REPO, private=True, exist_ok=True)
        try: api.upload_folder(folder_path=ckpt_dir, repo_id=CKPT_REPO, commit_message=f"checkpoint {state['step']}")
        except Exception as e: print("CKPT_PUSH_FAILED", e)     # a failed push must not kill the run

if RESUME and CKPT_REPO:                       # rebuild and skip what is already done
    path = snapshot_download(CKPT_REPO, token=os.environ.get("HF_TOKEN"))
    state = json.load(open(f"{path}/progress.json"))
    model = PeftModel.from_pretrained(base, path, is_trainable=True)
    # replay the LR schedule state['step'] times; shuffle each epoch with a seed derived from the
    # epoch number, then skip the first state['i_in_epoch'] examples, so the order is reproducible
```

Rules that make this work:

- **Deterministic example order.** Seed the shuffle per epoch (`Random(100 + epoch)`),
  so "skip the first N of this epoch" means the same thing on the new VM.
- **Checkpoint the schedule too**, at least the step count, or the restarted run
  warms up a second time.
- **Small and frequent beats big and rare**: a rank-16 adapter for an 8B is ~100 MB
  and pushes in seconds, so every 50 steps is cheap insurance.
- **Verify the checkpoint, not the intention**: the hub repo's file list and the
  `progress.json` it serves are the evidence that a restart would find something.
- The same shape works for any long job — a DSPy compile can checkpoint its
  compiled program and the examples already scored.

## Writing your own

- Print progress and end with a sentinel line so the log is self-verifying.
- Save checkpoints and results under `HARNESS_JOB_DIR`; nothing else on the
  VM survives the runtime.
- Long runs: `node colab.mjs keep --minutes 240` first, and note the lease
  never expires while the job is running anyway. For anything over ~30 min,
  run it with `--supervise` and checkpoint (see the section above): the lease
  is not what takes a runtime away.
- GPU-heavy scripts and vLLM cannot share the L4; see the rule in `recipes/vllm.md`.
