# Setup: the shared token (one time)

The local CLI and the job server on the VM share one secret. It is not a
Google credential. It lives in `~/.colab-harness/token` here and in Colab's
secret store there, so no session ever prints it.

Requirements: Node 18+ locally; a Google account with Colab Pro (free tier
works with a T4 but disconnects sooner).

## Steps

1. Generate the token here. It is written with mode 600 and not printed:

   ```bash
   cd <this skill>/scripts && node colab.mjs init
   pbcopy < ~/.colab-harness/token        # Linux: xclip -sel clip < ~/.colab-harness/token
   ```

2. **User does this part.** Open any notebook in Colab, for example
   `https://colab.research.google.com/github/apresmoi/skills/blob/main/skills/colab-harness/Colab_Harness.ipynb`.
   Left sidebar → 🔑 key icon ("Secrets") → **+ Add new secret** →
   Name `HARNESS_TOKEN`, Value: paste → switch on **Notebook access**.
   An agent may open the panel and fill the name; it must not paste the value.
3. Verify on the next session start: cell 1 prints
   `token: from Colab secret HARNESS_TOKEN`. If it prints
   `generated for this session`, the secret is missing or its toggle is off;
   the notebook then falls back to a one-off token and prints it with the
   URL, which works for that session only.

## Rotate

`node colab.mjs init --force`, then replace the value in the Secrets panel.
Secrets are per Google account, so this covers every notebook you run.
