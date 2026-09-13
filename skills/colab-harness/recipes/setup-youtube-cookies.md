# Setup: YouTube cookies (one time, refreshed when they expire)

YouTube refuses downloads from Colab's IP ranges without a logged-in session
("Sign in to confirm you're not a bot"). The fix is a Netscape-format
`cookies.txt` exported from a browser where you are logged in to YouTube.
The CLI uploads it with each `youtube` job; the VM deletes it when the job
ends. It is never stored in Drive or in a secret.

**Agent rule: never open, print, copy, or move this file. Ask the user to do
steps 1 to 3, then verify with step 4.**

## Steps (user)

1. In the browser logged in to YouTube, install a Netscape cookie exporter,
   e.g. "Get cookies.txt LOCALLY" or "Get cookies.txt CLEAN".
2. Open `youtube.com`, click the extension, export **for the current site
   only**.
3. Move it into place:

   ```bash
   mv ~/Downloads/youtube.com_cookies.txt ~/.colab-harness/youtube-cookies.txt
   chmod 600 ~/.colab-harness/youtube-cookies.txt
   ```

## Verify (agent)

```bash
node colab.mjs youtube "https://www.youtube.com/watch?v=jNQXAC9IVRw"   # 19-second public clip
```

Success prints the title, duration, and `cookies_used: true`. The audio
stays on the VM; add `--fetch-audio` to bring the wav back.

## When it breaks

A job that fails with `COOKIE_EXPIRED` means YouTube rejected the session:
ask the user to repeat steps 2 and 3. Cookies typically last weeks.
`--no-cookies` tries without (rarely works from Colab); `--cookies PATH`
uses a different file.
