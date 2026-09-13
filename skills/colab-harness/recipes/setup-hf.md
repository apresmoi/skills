# Setup: Hugging Face token and gated models (one time)

Needed for gated models: pyannote (diarization) and Gemma among others.
Whisper large-v3 and most Qwen models are not gated and need none of this.

## Steps

1. **User does this part.** Create a read token at
   `https://huggingface.co/settings/tokens`. In Colab, 🔑 Secrets →
   **+ Add new secret** → Name `HF_TOKEN`, Value: paste → Notebook access on.
2. **User does this part.** Accept the model terms, once per model, logged in
   as the same account:
   - `https://huggingface.co/pyannote/speaker-diarization-3.1`
   - `https://huggingface.co/pyannote/segmentation-3.0`
   - any gated LLM you want in vLLM, e.g. `https://huggingface.co/google/gemma-3-12b-it`
3. Verify on the next session start: cell 3 prints
   `HF_TOKEN: passed to the server (gated models OK)`. The server exports it
   to every job and to vLLM.

## Symptoms

- `diarize` fails with `could not load pyannote/...: accept its terms` →
  step 2 not done for that account.
- `vllm start` fails with a 401 or "gated repo" in `vllm status` log tail →
  same, for that model.
