# Setup: YouTube cookies (one time, refreshed when they expire)

YouTube refuses downloads from Colab's IP ranges unless the request carries
a logged-in session, and that session can only come from the user's
browser as a Netscape-format `cookies.txt`. The CLI uploads the file with
each `youtube` job; the VM deletes it when the job ends. It is never stored
in Drive or in a secret, and it never goes through the chat.

**Agent rules:** never open, print, copy, paste, or summarise the file, and
never ask the user to paste it into the chat. The user exports it; the CLI
moves it. The only facts you may report come from `cookies status`: present
or not, cookie count, earliest expiry.

## The onboarding message (send this, verbatim, adjusting nothing but the greeting)

> To download from YouTube on Colab I need a cookie file from your browser,
> because YouTube blocks datacenter IPs without a logged-in session. It never
> passes through this chat; you export it, a command files it away.
>
> 1. In the Chrome you use for YouTube, install **Get cookies.txt LOCALLY**:
>    https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc
> 2. Open https://www.youtube.com while logged in, click the extension's
>    icon, choose **Export** (current site only). A file like
>    `youtube.com_cookies.txt` lands in your Downloads.
> 3. Run:
>    ```
>    node <skill>/scripts/colab.mjs cookies install
>    ```
>    It finds the newest YouTube export in Downloads, moves it to
>    `~/.colab-harness/youtube-cookies.txt` with owner-only permissions, and
>    prints only how many cookies it holds and when the first one expires.
>
> Tell me when that's done and I'll verify with a 19-second public clip.
> When the session expires, weeks from now, a job will fail with
> `COOKIE_EXPIRED` and I'll ask you to repeat steps 2 and 3.

## Verify (agent)

```bash
node colab.mjs cookies status
node colab.mjs youtube "https://www.youtube.com/watch?v=jNQXAC9IVRw"   # 19-second public clip
```

Success prints the title, duration, and `cookies_used: true`. The audio
stays on the VM; `--fetch-audio` brings the wav back.

## Maintenance

- `cookies status`: present or not, count, earliest expiry, when placed.
- `cookies remove`: delete the file.
- `cookies install <file>`: use an explicit path instead of Downloads.
- A job failing with `COOKIE_EXPIRED` means YouTube rejected the session:
  send the message above again, starting at step 2.
- `--no-cookies` tries without (rarely works from Colab); `--cookies PATH`
  uses another file for one job.
