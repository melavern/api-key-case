# demo/ — the API Key Case demo video

Generates English and Japanese editions of an ~83-second, 1080p product demo
from the same **real run of this working tree's CLI**. The Japanese edition
localizes the explanatory cards and captions; the captured CLI output remains
English so the terminal recording is never rewritten.

This directory is a build tool, not part of the product. The root
`package.json` ships only `dist/` and the allowlisted user-facing documents
(`README.md`, `README.ja.md`, `CHANGELOG.md`, `LICENSE`, `NOTICE`, `SECURITY.md`,
and `SUPPORT.md`), so nothing here reaches the npm package. Its dependencies are declared in
`demo/package.json` and are not installed by a normal `npm install` at the root.

```sh
cd demo
npm install       # once — pulls a prebuilt node-pty
npm run demo      # capture -> render -> encode -> verify -> clean up
npm run demo:ja   # reuse the transcript -> Japanese edition (keeps English)
npm run demo:all  # rebuild both editions in sequence
```

Output lands in `demo/build/` (git-ignored):

| file | what it is |
| --- | --- |
| `demo.mp4` | 1920×1080, 30fps, H.264 + silent AAC track |
| `demo-poster.jpg` | poster frame for `<video poster>` / social cards |
| `captions.srt` | English subtitles matching the on-screen commentary |
| `demo-ja.mp4` | Japanese explanatory cards and licensed BGM, with the real English CLI output |
| `demo-ja-poster.jpg` | Japanese poster frame |
| `captions-ja.srt` | Japanese subtitles matching the localized commentary |
| `transcript.json` | every line the CLI actually printed, with exit codes |
| `scene.html` | the rendered scene with the timeline embedded |

## Requirements

- Node 20+ (the CDP driver uses the global `WebSocket`, so 22+ is smoother)
- Chrome or Edge — auto-detected, or set `CHROME_PATH`
- ffmpeg — auto-detected, including a winget install, or set `FFMPEG_PATH`
  (`winget install Gyan.FFmpeg`)
- A built `dist/` — `run-demo.mjs` runs `npm run build` at the root if it is missing
- For the Pro scenes: a Pro license on this machine, plus `wrangler` installed
  and logged in. Without them, `capture.mjs` fails loudly rather than
  quietly recording a different story.

## Japanese-edition BGM

The published Japanese edition uses `assets/bgm/Mesmerizing Galaxy Loop.mp3`
at 18% source volume with short fade-in and fade-out. The English
edition remains unchanged and silent. Track and license details are recorded
in [`assets/bgm/README.md`](assets/bgm/README.md).

To rebuild the Japanese edition with the reviewed track:

```sh
node run-demo.mjs --locale ja --skip-capture --bgm "assets/bgm/Mesmerizing Galaxy Loop.mp3"
```

## How honest is it?

Every terminal line in the video is captured from a real process:

- `capture.mjs` runs the CLI inside a **genuine pty** (`lib/pty.mjs`), so the
  interactive paths behave exactly as they do for a human — including the
  `save` prompt and the production confirmation, both of which refuse
  non-interactive input by design and cannot be scripted any other way.
- `lib/screen.mjs` replays the ConPTY byte stream onto a character grid, which
  reproduces the screen a human would have seen. Nothing is reworded, reordered
  or trimmed.
- `storyboard.mjs` decides *when* each recorded line appears. It never decides
  what a line says.
- The renderer adds colour to terminal lines for legibility. The characters
  themselves come straight from `transcript.json`.

Three things on screen are staged rather than captured, and are labelled here
so nobody has to guess:

1. **The shell prompt** is drawn as `$ `. The real capture runs through a
   launcher named `api-key-case` (built in `build/bin/`) so the recorded argv
   really is `api-key-case scan .` and not `node dist/cli/index.js scan .`.
2. **The terminal is cleared between commands**, the way a person clears
   between takes.
3. **The commentary column, the intro and the outro** are written copy, kept
   visually separate from the terminal panel.

The `deploy` shots are a `--dry-run` and a production run that is answered
`no`. Nothing is ever sent to Cloudflare: both paths return before the CLI
reads the stored value.

## Security properties

- The demo secret (`OPENAI_API_KEY` in the sandbox's project scope) is a
  fabricated string, typed into the non-echoing prompt, and deleted by
  `cleanup-demo.mjs` through the product's own `remove` command.
- The sandbox project lives outside the repository, in a directory with no
  account name in its path, and is deleted at the end.
- `capture.mjs` aborts if the demo value ever appears in the transcript.
- `verify-demo.mjs` re-checks the finished artifacts for the demo value, for
  anything matching a credential shape, for the local account name, and for
  this machine's Pro license identifier. Because `build/scene.html` embeds the
  entire timeline, and the renderer can only draw what is in the timeline, a
  string absent from `scene.html` cannot appear in any frame of the video.
- The `.env` in the sandbox is a fixture containing placeholder text. No real
  `.env` is read at any point.

## Files

| file | role |
| --- | --- |
| `config.mjs` | paths, video size, sandbox location, ffmpeg/Chrome discovery |
| `setup-demo.mjs` | builds the throwaway `demo-checkout` project and its git history |
| `capture.mjs` | runs the real CLI in a pty, writes `transcript.json` |
| `storyboard.mjs` | timeline: when each captured line appears, plus commentary and `.srt` |
| `scene.html` | deterministic renderer — `renderFrame(t)` is a pure function of time |
| `render-frames.mjs` | headless Chrome over CDP → PNG sequence |
| `build-video.mjs` | ffmpeg → `demo.mp4` + poster |
| `verify-demo.mjs` | artifact leak checks |
| `cleanup-demo.mjs` | removes the sandbox and the demo secret |
| `preview.mjs` | renders selected timestamps to `build/preview/` for layout work |
| `publish-demo.mjs` | stages the site bundle and deploys it to Cloudflare Pages |
| `lib/pty.mjs` | real pty with scripted keystrokes |
| `lib/screen.mjs` | ANSI/ConPTY screen emulator |
| `lib/cdp.mjs` | dependency-free Chrome DevTools Protocol client |

## Local LP preview

The Development Hub's `keycase:api` service runs `serve-site.mjs` on the
working tree so the latest LP can be checked before publication. It serves the
same allowlisted bundle shape as the publishing script: the five HTML pages,
`robots.txt`, `sitemap.xml`, the three committed announcement files
(`launch-ja.mp4`, `launch-ja-poster.jpg`, `launch-ja.vtt`), the brand assets
(`favicon.ico` and `brand/`: SVG mark/logo/favicon, touch icon, OG image), and the six
generated demo media files under `demo/build/` (when present). Repository source, tests, docs, configuration,
and other build artifacts are not HTTP routes. The server binds to loopback;
mobile publication and `remoteAccess.services` are managed separately by the
Development Hub.

## Publishing

`publish-demo.mjs` copies the repository's pages, the committed 28-second
announcement embedded in the landing page (`launch-ja.mp4`,
`launch-ja-poster.jpg`, `launch-ja.vtt` at the repository root — rendered by the
private marketing-video harness, not by this directory; provenance in
`docs/landing-page/PAGE_SPEC.md` §7), the brand assets (`favicon.ico`, `brand/`),
plus both language editions of the demo
(`demo*.mp4`, posters, and WebVTT captions) into `build/site/`, checks the page
actually references every asset, and can deploy that directory to the existing
`api-key-case-lp` Cloudflare Pages project:

```sh
node publish-demo.mjs            # stage only, print the deploy command
node publish-demo.mjs --deploy   # stage, then deploy to production
node publish-demo.mjs --preview  # stage, then update the fixed preview branch
```

For the LP analytics hook used by the review Preview and later production,
set the public PostHog Project Token and region explicitly in the process
environment before staging, or put them in the ignored repository-root
`.env.local` for repeated Preview updates. Preview settings use process
environment variables first, then `.env.local`; other `.env` files are not
read. The script only accepts the US or EU PostHog capture host:

```sh
API_KEY_CASE_LP_POSTHOG_PROJECT_TOKEN=<API Key Case public Project Token> \
API_KEY_CASE_LP_POSTHOG_API_HOST=https://us.i.posthog.com \
node publish-demo.mjs --preview
```

For local setup, create `.env.local` once with the two settings above. On
PowerShell, process variables can still be set with `$env:` for a one-off
override. If the token is absent, staging intentionally publishes a safe
no-op analytics page; an invalid token or host fails before deployment. Use
only the public Project Token, never a Personal API Key or Project Secret API
Key. The `--deploy` Production path remains separate and does not read
`.env.local`.

The `--preview` command deploys the same staged site to the existing
`api-key-case-lp` Pages project with the fixed `preview` branch name. It refuses
to deploy if the public PostHog token is missing, so the review Preview stays
connected to the shared project. Wrangler prints the actual branch alias after
deployment; do not infer or hard-code that URL from the project name.

The project holds only these files, so a deployment replaces the landing page
and the video together and removes nothing else.

## Editing the video

Content, wording and pacing live in `storyboard.mjs`; layout and styling live
in `scene.html`. To iterate on either without re-capturing or re-encoding:

```sh
node preview.mjs 4000 17600 58000     # stills at those timestamps
node preview.mjs --locale ja 4000 17600 58000
node run-demo.mjs --skip-capture      # reuse the recorded transcript
node run-demo.mjs --locale ja --skip-capture
node run-demo.mjs --locale ja --skip-capture --bgm path/to/reviewed-bgm.mp3
node run-demo.mjs --keep-frames       # keep build/frames/ for inspection
```

`--bgm` loops the selected audio, mixes it at 10% volume, and adds a short
fade-in/fade-out. Use only an instrumental file whose commercial-use rights
have been reviewed; the artifact leak checker can inspect rendered text but
cannot determine what spoken audio contains. Omitting `--bgm` preserves the
original silent AAC track.

Re-running `npm run demo` from scratch takes roughly five minutes, most of it
in the frame render.
