// One command: real CLI capture -> frames -> demo.mp4 -> cleanup.
//
//   cd demo && npm install && npm run demo
//
// Flags:
//   --keep-frames   leave build/frames/ in place for inspection
//   --keep-sandbox  leave the sandbox project and its demo secret in place
//   --skip-capture  reuse build/transcript.json from a previous run
//   --locale en|ja  render the English original or Japanese edition
//   --bgm <path>    mix a reviewed instrumental track at low volume

import { existsSync } from "node:fs";
import { isMain } from "./lib/main.mjs";
import { TRANSCRIPT_PATH, demoBgmFromArgs, demoLocaleFromArgs, demoVariant } from "./config.mjs";
import { buildVideo, probe } from "./build-video.mjs";
import { capture } from "./capture.mjs";
import { cleanup } from "./cleanup-demo.mjs";
import { renderFrames } from "./render-frames.mjs";
import { verifyArtifacts } from "./verify-demo.mjs";

const flags = new Set(process.argv.slice(2));

async function main() {
  const started = Date.now();
  const locale = demoLocaleFromArgs();
  const variant = demoVariant(locale);
  const bgmPath = demoBgmFromArgs();

  if (flags.has("--skip-capture")) {
    if (!existsSync(TRANSCRIPT_PATH)) {
      throw new Error("--skip-capture was passed but build/transcript.json does not exist.");
    }
    console.log("== 1/4 capture (skipped, reusing build/transcript.json)");
  } else {
    console.log("== 1/4 capture: running the real CLI in a pty");
    await capture();
  }

  console.log("== 2/4 render: headless Chrome frame sequence");
  await renderFrames({ locale });

  console.log("== 3/4 encode: ffmpeg");
  buildVideo({ keepFrames: flags.has("--keep-frames"), locale, bgmPath });

  console.log("== 4/4 verify + cleanup");
  verifyArtifacts({ locales: [locale] });
  if (flags.has("--keep-sandbox")) {
    console.log("sandbox kept (--keep-sandbox)");
  } else {
    await cleanup();
  }

  console.log(probe(locale));
  console.log(`done in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${variant.videoPath}`);
}

// node-pty keeps a ConPTY handle open on Windows, so the process would sit
// there after all the work is done. Flush, then exit explicitly.
function flushAndExit(code) {
  process.stdout.write("", () => process.exit(code));
}

if (isMain(import.meta.url)) {
  main().then(
    () => flushAndExit(0),
    (err) => {
      console.error(`\nFAILED: ${err.message}`);
      flushAndExit(1);
    }
  );
}
