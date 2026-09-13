# Setup: Hugging Face token, gated models, pushing results (one time)

One token, secret `HF_TOKEN`, does two jobs: downloading gated models
(pyannote for diarization, Gemma, and others) and pushing trained adapters
to your own **private** repos. Whisper large-v3 and most Qwen models are not
gated and need none of this for downloads.

## Steps

1. **User does this part.** Create a token at
   `https://huggingface.co/settings/tokens`. Choose **Write** (classic), or
   a fine-grained token with "Write access to contents/settings of all repos
   under your personal namespace" plus "Read access to public gated repos".
   A read-only token still works for downloads, but every `--push` is
   refused before the job starts. In Colab, 🔑 Secrets →
   **+ Add new secret** → Name `HF_TOKEN`, Value: paste → Notebook access on.
   An agent may open the panel and fill the name; it must not paste the value.
2. **User does this part.** Accept the model terms, once per model, logged in
   as the same account:
   - `https://huggingface.co/pyannote/speaker-diarization-3.1`
   - `https://huggingface.co/pyannote/segmentation-3.0`
   - any gated LLM you want in vLLM, e.g. `https://huggingface.co/google/gemma-3-12b-it`
3. Verify on the next session start: cell 3 prints
   `HF_TOKEN: passed to the server (gated models OK)`, and `connect` prints
   `hf: <user> · write token · can push (private repos)`. The server exports
   the token to every job and to vLLM; `node colab.mjs hf` repeats the check.
   The token value is never printed, here or on the VM.

## Rotate or upgrade to write

Replace the value in the Secrets panel, then restart the runtime, or
`node colab.mjs reload` on a running one. The old token keeps working
until you revoke it on huggingface.co.

## Symptoms

- `diarize` fails with `could not load pyannote/...: accept its terms` →
  step 2 not done for that account.
- `vllm start` fails with a 401 or "gated repo" in `vllm status` log tail →
  same, for that model.
- `--push` dies with `HF_TOKEN is a read token and cannot write` → step 1
  with a write token, then rotate as above.
