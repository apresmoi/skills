# Transcribe, diarize, YouTube, pipeline

Prerequisites: a connected session (`recipes/session.md`); for `diarize`
and `pipeline`, HF_TOKEN and the pyannote terms (`recipes/setup-hf.md`);
for `youtube`, the cookie file (`recipes/setup-youtube-cookies.md`).

## One command for the whole thing

```bash
node colab.mjs pipeline <youtube-url | audio-file> [--language es] [--speakers N] [--out DIR]
```

Download or upload → diarize → transcribe with speaker labels. Fetches
`metadata.youtube.json` (if a URL), `dump.json`, `grouped.json`,
`transcription.json`, `transcript.md` into `--out` or `colab-jobs/<id>/`.
Measured: 23 s end to end for a 24 s clip on an L4, cold models included.

## The pieces

```bash
node colab.mjs transcribe talk.wav [--model large-v3] [--language es] [--compute-type float16] [--word-timestamps] [--out DIR]
node colab.mjs diarize talk.wav [--speakers N] [--out DIR]
node colab.mjs transcribe --from-job <diarize-id> --diarization <diarize-id>    # reuse the VM-side file, label speakers
node colab.mjs youtube <url> [--fetch-audio] [--out DIR]
```

- Uploads go in 8 MB chunks (tunnel cap); an hour of 16 kHz mono wav is
  about 115 MB and takes a minute or two.
- `--from-job ID` reuses a file already on the VM (`audio.wav` or the job's
  input) instead of uploading again; `--from-file NAME` picks another file.
- `transcribe` output: `transcription.json` with `segments[{start,end,text,
  speaker?}]`, `language`, `duration`; `transcript.md` as
  `[hh:mm:ss → hh:mm:ss] SPEAKER_00: text`. faster-whisper large-v3,
  float16 on GPU by default.
- `diarize` output: `dump.json` raw turns, `grouped.json` with same-speaker
  turns merged across gaps under 3 s. pyannote
  speaker-diarization-3.1 in its own venv; first use builds it (about a
  minute). Speaker labels are `SPEAKER_00`, `SPEAKER_01`, ...
- `youtube` output: `audio.wav` on the VM (mono 16 kHz), `metadata.youtube.json`
  fetched; the wav comes back only with `--fetch-audio`. Failure
  `COOKIE_EXPIRED` → cookie recipe.

## Checks

- Diarization on a two-voice clip returned 2 speakers and the exact turn
  order; the labelled transcript matched all segments. Expect real
  recordings to need `--speakers N` when the count is known.
- If `diarize` fails mentioning matplotlib backend, torchaudio, or CUDA
  versions, the venv is stale: `node colab.mjs run "rm -rf /content/pyannote-venv"`
  and rerun; it rebuilds.
