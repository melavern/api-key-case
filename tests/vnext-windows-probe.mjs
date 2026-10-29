// Noninteractive native probe: construct/dispose controls without showing a
// window or invoking Save. Only a random, absent v3 account is probed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { emptyCatalog, locatorAccount } from "../dist/core/vnext/model.js";
import { prepareRegistration } from "../dist/core/vnext/registration.js";
import { WindowsHumanPlane, resolveWindowsPowerShell, buildWindowsVNextSecretInputScript, encodeWindowsHelperCommand } from "../dist/core/human/windows.js";

if (process.platform !== "win32") { console.log("SKIP vNext Windows noninteractive probe: Windows required"); process.exit(0); }
const id = randomUUID(), now = new Date().toISOString(), catalog = emptyCatalog();
const candidate = { id, label: "Synthetic 日本語 O'Brien $()", locator: { kind: "v3", id, generationId: randomUUID() },
  generation: 1, classification: "nonproduction", createdAt: now, revisedAt: now };
const operation = prepareRegistration(catalog, candidate, randomUUID(), now), plan = { catalog, operation };
const native = new WindowsHumanPlane(resolveWindowsPowerShell());
assert.equal(await native.probeVNextPresence(candidate.locator), "absent");
let calls = 0;
const probe = new WindowsHumanPlane(resolveWindowsPowerShell(), async request => {
  calls++;
  const source = buildWindowsVNextSecretInputScript(plan);
  const cut = source.indexOf("$form.ShowDialog() | Out-Null"); assert.ok(cut > 0);
  const code = source.slice(0, cut) + `\nif(-not $input.UseSystemPasswordChar -or $input.TextLength -ne 0 -or $input.MaxLength -ne 0){exit 20}
    if($context.Text -notmatch 'Development / testing|開発・検証' -or $saveButton.Enabled -ne $true){exit 21}
    $form.Dispose(); [Environment]::Exit(0)`;
  const result = spawnSync(request.executable, [...request.args.slice(0, -1), encodeWindowsHelperCommand(code)],
    { cwd: request.cwd, env: request.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, encoding: "utf8" });
  // Do not echo native error strings or script contents through this fixture.
  assert.equal(result.status, 0, `noninteractive native construction exit ${result.status}`);
  assert.equal(result.stdout, ""); assert.equal(result.stderr.replace(/^#< CLIXML\s*$/, ""), ""); return 2;
});
assert.equal(await probe.askVNextSecret(plan), "cancelled"); assert.equal(calls, 1);
assert.equal(await native.probeVNextPresence(candidate.locator), "absent");
assert.match(locatorAccount(candidate.locator), /^v3\|credential\|/);
console.log("PASS vNext Windows native construction + absent-only presence probe; no shown UI, store write or approval");
