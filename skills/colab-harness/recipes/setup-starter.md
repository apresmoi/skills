# Setup: how runtimes get started (one time, refreshed when Google auth expires)

Colab has no API to allocate a VM: a browser has to click **Run all** once
per session, and every session gets a new random tunnel URL. The skill
absorbs both. The URL is published by the notebook to a private Hugging
Face repo and found by a bare `connect`. The click is done by a *starter*,
chosen once as a preference and overridable per run:

| starter | who clicks | needs | headless |
|---|---|---|---|
| `playwright` (recommended) | a Chrome profile owned by the skill, signed in with exported cookies | a Playwright install on the machine, a one-time cookie export | yes |
| `chrome` | the agent, through the Claude in Chrome extension | that tool in the session, the extension on the same claude.ai account as the terminal | no |

```bash
node colab.mjs config set starter playwright     # or chrome; asked once if unset
node colab.mjs start                             # uses the preference
node colab.mjs start --via chrome                # this one in Chrome
node colab.mjs start --via playwright --gpu L4   # this one in Playwright
```

**Agent rules.** Never ask the user for a URL. If no starter is set, ask
once which they want and save it. If the chosen starter cannot work in this
session (no extension tool, no Playwright), say so and offer the other.

## Playwright starter: Google auth by cookie export

The profile lives in `~/.colab-harness/chrome`, separate from the user's
Chrome, so the accounts the user switches between elsewhere do not matter.
It is signed in with a `cookies.txt` export, exactly like the YouTube
cookies: the user exports, one command files it, an agent never opens,
prints, copies, or pastes the file. `node colab.mjs auth` prints the
onboarding message; send it verbatim.

```bash
node colab.mjs auth                 # the message with the export steps
node colab.mjs auth install [file]  # newest google/colab *cookies*.txt from ~/Downloads → ~/.colab-harness/google-cookies.txt, seeds the profile, verifies
node colab.mjs auth status          # "signed in: <account>" or what to do
node colab.mjs auth remove          # delete the cookie file and the profile
```

Playwright is not installed by this skill. It is resolved from
`PLAYWRIGHT_ROOT`, this skill's own `node_modules` if any, or the projects
listed as `playwright_roots` in `~/.colab-harness/config.json`. The real
Google Chrome is used (channel `chrome`), nothing is downloaded.

## Debug: auth lost

- `start` fails with `AUTH_EXPIRED`, or `auth status` says not signed in:
  Google ended the session. Send the `auth` message again from step 2;
  `auth install` reseeds the profile.
- `auth install` refuses the file for lacking `SID` / `__Secure-1PSID`: it was
  exported from the Colab page; the login cookies live on `.google.com`, so
  export from https://www.google.com/.
- `auth install` says "cookies did not sign in": the export was taken while
  logged out, or from a different account than the one with Colab Pro.
- `start` hangs on "opening the notebook": run `start --headed` once to see
  what Colab shows (a consent or challenge page); the window is the
  skill's profile, not the user's Chrome.
- `start` fails with `COLAB: Cannot connect to GPU backend`: no L4 free or
  the allowance is spent; retry later or `--gpu T4`.
- `check` prints the starter, its sign-in state and the next command.

## Chrome starter

The agent opens the notebook link, sets Runtime → Change runtime type →
L4, clicks Run all, dismisses the GitHub warning, then runs `connect`. The
extension only answers a Claude Code signed into the same claude.ai account
as the extension; when the terminal's account changes, the extension
reports "not connected". Use `start --via playwright` then.
