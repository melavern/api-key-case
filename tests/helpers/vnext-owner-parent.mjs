// Synthetic process-death fixture only. No OS store or external service.
import { readFileSync } from "node:fs";
import { captureProfile } from "../../dist/core/local/profile-snapshot.js";
import { spawnWindowsProfileOwner } from "../../dist/core/local/windows-launch-owner.js";
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
const owner = spawnWindowsProfileOwner(captureProfile(request.app, request.profile, ["OTHER_KEY", "other_key2"]), request.profile);
owner.stdout.setEncoding("utf8"); let buffer = "";
owner.stdout.on("data", chunk => {
  buffer += chunk;
  for (;;) {
    const pos = buffer.indexOf("\n"); if (pos < 0) break; const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
    if (line === "READY") owner.stdin.write(JSON.stringify({ value0: "akc-synthetic-parent", value1: "akc-synthetic-parent" }) + "\n");
    else if (line === "CREATED") owner.stdin.write("RELEASE\n");
    else if (line === "STARTED") setTimeout(() => process.exit(73), 500);
    else process.exit(74);
  }
});
setTimeout(() => { owner.kill(); process.exit(75); }, 15000);
