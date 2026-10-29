// Generated scripts and fake launchers only: no native dialog or OS-store access.
import assert from "node:assert/strict";
import { decodeWindowsHelperScript } from './windows-helper-command.mjs';
import { pathToFileURL } from "node:url";
import { Script } from "node:vm";
import {
  MacOSHumanPlane, MACOS_OSASCRIPT_PATH,
  buildMacOSSecretInputScript, buildMacOSRemovalScript, buildMacOSApprovalScript
} from "../dist/core/human/macos.js";
import {
  WindowsHumanPlane, WINDOWS_POWERSHELL_PATH,
  buildWindowsSecretInputScript, buildWindowsRemovalScript, buildWindowsApprovalScript
} from "../dist/core/human/windows.js";

const legacy = {
  scope: "project", projectId: "0123456789abcdef", name: "RESEND_API_KEY",
  projectDir: "/synthetic/日本語 project"
};
const builders = [
  [buildMacOSSecretInputScript, buildMacOSRemovalScript],
  [buildWindowsSecretInputScript, buildWindowsRemovalScript]
];
const approvalBuilders = [buildMacOSApprovalScript, buildWindowsApprovalScript];
const planes = [
  [MacOSHumanPlane, MACOS_OSASCRIPT_PATH, (request) => request.args.at(-1)],
  [WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, (request) => decodeWindowsHelperScript(request.args.at(-1))]
];
const approvalBase = {
  ...legacy, target: "vercel", env: "preview", force: false,
  destination: "project:synthetic-app", cliPath: "/synthetic/bin/vercel",
  command: "vercel env add RESEND_API_KEY preview", preCommands: [], trustState: "first-use"
};
const connectionSource = {
  credentialVersion: 2, service: "resend", environment: "preview",
  credentialRevision: "2026-10-02T12:34:56.789Z"
};

function assertWindowsApprovalFixture(script) {
  // Inspect emitted text only. Native drawing, OS verification and visual
  // acceptance at either DPI remain separate human-owned acceptance gates.
  for (const line of [
    "$form.ClientSize = New-Object System.Drawing.Size(660, 400)",
    "$details = New-Object System.Windows.Forms.TextBox",
    "$details.Location = New-Object System.Drawing.Point(18, 48)",
    "$details.Size = New-Object System.Drawing.Size(624, 268)",
    "$details.Multiline = $true", "$details.ReadOnly = $true",
    "$details.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical",
    "$details.TabStop = $false",
    "$noButton.Location = New-Object System.Drawing.Point(454, 340)",
    "$yesButton.Location = New-Object System.Drawing.Point(554, 340)",
    "$script:resultCode = 2",
    "$form.AcceptButton = $noButton", "$form.CancelButton = $noButton",
    "$form.Add_Shown({ $noButton.Focus() })",
    "$noButton.Add_Click({ $script:resultCode = 2; $script:form.Close() })",
    "$form.Add_FormClosing({ if ($script:resultCode -ne 0 -and $script:resultCode -ne 10) { $script:resultCode = 2 } })",
    "  if (-not [ApiKeyCaseHumanPlane.UserConsentVerifierNative]::IsSupportedBuild(22000)) { return -1 }",
    "    $verificationResult = Invoke-ApiKeyCaseUserVerification $script:form.Handle $verificationMessage",
    "      default { $script:resultCode = 10 }"
  ]) assert.ok(script.split("\n").includes(line), `Missing Windows approval fixture: ${line}`);
  assert.ok(script.includes("RequestVerificationForWindowAsyncDelegate"));
  for (const [value, code, state] of [
    [0, 0, "Verified"], [1, 10, "DeviceNotPresent"], [2, 10, "NotConfiguredForUser"],
    [3, 10, "DisabledByPolicy"], [4, 10, "DeviceBusy"], [5, 10, "RetriesExhausted"], [6, 2, "Canceled"]
  ]) {
    assert.match(script, new RegExp(`${value} \\{ \\$script:resultCode = ${code} \\} +# ${state}`));
  }
  assert.equal((script.match(/\$script:resultCode = 0/g) ?? []).length, 1,
    "Verified must be the only emitted approval path");
  assert.ok(script.includes("$yesButton.Add_Click({\n  $script:resultCode = 10"));
  assert.ok(script.includes("  } catch {\n    $script:resultCode = 10"));
}

async function runConnectionApprovalTests() {
  for (const environment of ["development", "preview", "production"]) {
    for (const target of ["vercel", "cloudflare", "github"]) {
      const legacyPlan = { ...approvalBase, target, env: environment };
      const source = { ...connectionSource, environment };
      const plan = { ...legacyPlan, connectionSource: source };
      const macScript = buildMacOSApprovalScript(plan);
      const winScript = buildWindowsApprovalScript(plan);
      new Script(macScript);
      assert.ok(macScript.includes(`Source: v2 Resend / ${environment}`));
      assert.ok(macScript.includes(`Registration revision: ${source.credentialRevision}`));
      assert.ok(macScript.includes("noButton.keyEquivalent = '\\r';"));
      assert.ok(macScript.includes("alert.window.initialFirstResponder = noButton;"));
      assert.ok(macScript.includes("$.exit(Number(response) === Number($.NSAlertSecondButtonReturn) ? 0 : 2);"));

      // These additions are display context, not a new approval primitive.
      // Removing only them must recover the entire unchanged legacy script.
      const macWithoutSource = macScript.split("\n")
        .filter((line) => !line.includes("Source: v2 Resend /") && !line.includes("Registration revision:"))
        .join("\n");
      assert.equal(macWithoutSource, buildMacOSApprovalScript(legacyPlan));
      const detailSource = `(Get-AkcText 'Source: ' '保存元: ') + 'v2 Resend / ${environment}'`;
      const detailRevision = `(Get-AkcText 'Registration revision: ' '登録リビジョン: ') + '${source.credentialRevision}'`;
      const winWithoutSource = winScript
        .replace(`${detailSource} + [Environment]::NewLine + `, "")
        .replace(`${detailRevision} + [Environment]::NewLine + `, "")
        .replace(`; v2 Resend source ${environment}`, "")
        .replace(`; v2 Resend 保存元 ${environment}`, "");
      assert.equal(winWithoutSource, buildWindowsApprovalScript(legacyPlan));
      assertWindowsApprovalFixture(winScript);
      const details = winScript.split("\n").find((line) => line.startsWith("$details.Text = "));
      assert.ok(details);
      const orderedDetails = ["Secret name: ", "Source: ", "Registration revision: ", "Scope: ", "Target: ", "Environment: "];
      for (let i = 1; i < orderedDetails.length; i++) {
        assert.ok(details.indexOf(orderedDetails[i - 1]) < details.indexOf(orderedDetails[i]),
          `${orderedDetails[i]} must follow ${orderedDetails[i - 1]} in scrollable details`);
      }
      assert.ok(details.includes(detailSource));
      assert.ok(details.includes(detailRevision));
      const verification = winScript.split("\n").find((line) => line.startsWith("$verificationMessage = "));
      assert.ok(verification.includes(`; v2 Resend source ${environment} to ${target} (${environment}).`));
      assert.ok(verification.includes(`; v2 Resend 保存元 ${environment}→ ${target}（${environment}）。`));

      for (const [Plane, helper, decode] of planes) {
        for (const [code, expected] of [
          [0, "approved"], [2, "declined"], [10, "unavailable"], [null, "unavailable"],
          [1, "unavailable"], [6, "unavailable"], [-1, "unavailable"], [99, "unavailable"]
        ]) {
          const requests = [];
          const plane = new Plane(helper, async (request) => { requests.push(request); return code; });
          assert.equal(await plane.askApproval(plan), expected);
          assert.equal(requests.length, 1);
          const [request] = requests;
          assert.equal(request.executable, helper);
          assert.equal(request.stdio, "ignore");
          assert.equal(request.shell, false);
          assert.equal(request.detached, false);
          assert.equal(decode(request), Plane === MacOSHumanPlane ? macScript : winScript);
          for (const name of ["RESEND_API_KEY", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
            "CLOUDFLARE_API_TOKEN", "VERCEL_TOKEN", "GH_TOKEN"]) {
            assert.equal(Object.hasOwn(request.env, name), false, `${name} must not reach the approval helper`);
          }
        }
        let launched = false;
        const missing = new Plane(null, async () => { launched = true; return 0; });
        assert.equal(await missing.askApproval(plan), "unavailable");
        assert.equal(launched, false, "missing helpers cannot approve a connection deployment");
      }
    }
  }

  const complete = { ...approvalBase, connectionSource };
  const sourceCase = (patch) => ({ ...complete, connectionSource: { ...connectionSource, ...patch } });
  const invalid = [
    ...[null, false, 2, "resend", [], [connectionSource], {}]
      .map((source) => ["invalid source shape", { ...complete, connectionSource: source }]),
    ...Object.keys(connectionSource).map((field) => {
      const source = { ...connectionSource };
      delete source[field];
      return [`missing source ${field}`, { ...complete, connectionSource: source }];
    }),
    ...[undefined, null, 1, 3, "2"].map((credentialVersion) => ["invalid version", sourceCase({ credentialVersion })]),
    ...[undefined, null, "", "other", "Resend", "resend\nproduction", "resend'; throw 'injected"]
      .map((service) => ["invalid service", sourceCase({ service })]),
    ...[undefined, null, "", "staging", "Preview", "preview\nproduction", "preview|production", { toString: () => "preview" }]
      .map((environment) => ["invalid source environment", sourceCase({ environment })]),
    ...["development", "production"].map((environment) => ["source/environment mismatch", sourceCase({ environment })]),
    ...[undefined, null, "staging", "Preview"].map((env) => ["invalid deployment environment", { ...complete, env }]),
    ...[undefined, null, "", 1, new Date("2026-10-02T12:34:56.789Z"),
      "not-a-date", "2026-10-02", "2026-10-02T12:34:56Z", "2026-10-02T12:34:56.789+00:00",
      "2026-13-02T12:34:56.789Z", "2026-02-30T00:00:00.000Z", "2026-02-29T00:00:00.000Z",
      "2026-10-02T24:00:00.000Z", "2026-10-02T12:34:56.789Z\n", "2026-10-02T12:34:56.789Z'; throw 'injected"]
      .map((credentialRevision) => ["invalid registration revision", sourceCase({ credentialRevision })]),
    ["extra source field", sourceCase({ approved: true })],
    ["extra value field", sourceCase({ value: "synthetic-not-a-credential" })],
    ["wrong logical name", { ...complete, name: "OTHER_API_KEY" }],
    ["user scope", { ...complete, scope: "user", projectId: null }],
    ["unknown scope", { ...complete, scope: "team" }],
    ["unknown target", { ...complete, target: "other" }],
    ["missing project ID", { ...complete, projectId: null }],
    ["malformed project ID", { ...complete, projectId: "0123456789abcdef|production" }]
  ];
  for (const [label, plan] of invalid) {
    for (const build of approvalBuilders) {
      assert.throws(() => build(plan), /Invalid|Unsafe/, `${build.name}: ${label}`);
    }
    for (const [Plane, helper] of planes) {
      let launched = false;
      const plane = new Plane(helper, async () => { launched = true; return 0; });
      await assert.rejects(() => plane.askApproval(plan), /Invalid|Unsafe/, `${Plane.name}: ${label}`);
      assert.equal(launched, false, `${label} must fail before any approval helper launches`);
    }
  }

  // A source is optional only for legacy plans. The unchanged legacy path
  // still supports other logical names, user scope and GitHub.
  for (const plan of [approvalBase, {
    ...approvalBase, name: "OTHER_API_KEY", scope: "user", projectId: null,
    target: "github", env: "production", trustState: "always-approve"
  }]) {
    for (const build of approvalBuilders) {
      const script = build(plan);
      assert.equal(build({ ...plan, connectionSource: undefined }), script);
      assert.doesNotMatch(script, /v2 Resend|Registration revision:|登録リビジョン:/);
    }
    new Script(buildMacOSApprovalScript(plan));
    assertWindowsApprovalFixture(buildWindowsApprovalScript(plan));
  }
}

export async function runEnvironmentHumanPlaneTests() {
  for (const environment of ["development", "preview", "production"]) {
    const ref = { ...legacy, service: "resend", environment };
    const account = `v2|credential|project|${ref.projectId}|resend|${environment}|RESEND_API_KEY`;
    for (const [save, remove] of builders) {
      const saveScript = save(ref);
      const removalScript = remove({ ...ref, kind: "secret" });
      assert.ok(saveScript.includes(account));
      assert.ok(!saveScript.includes(`v1|project|${ref.projectId}|RESEND_API_KEY`));
      for (const script of [saveScript, removalScript]) {
        for (const detail of (script === saveScript && save === buildWindowsSecretInputScript ? ["Resend", "App environment: " + environment, "Project: " + ref.projectId, ref.projectDir] : ["Service: resend", `Environment: ${environment}`, `Project ID: ${ref.projectId}`, ref.projectDir])) {
          assert.ok(script.includes(detail), `Missing exact dialog detail: ${detail}`);
        }
      }
    }
    // Parse the emitted JXA as JavaScript without evaluating Objective-C APIs.
    new Script(buildMacOSSecretInputScript(ref));
    new Script(buildMacOSRemovalScript({ ...ref, kind: "secret" }));
    const winSave = buildWindowsSecretInputScript(ref);
    assert.ok(winSave.includes("対象環境：" + environment));
    assert.ok(winSave.includes("Resendのメール送信用キーを登録"));
    assert.ok(winSave.includes("$root.RowCount = 3"), "identity and secure footer have separate adaptive rows");
    const winRemoval = buildWindowsRemovalScript({ ...ref, kind: "secret" });
    assert.ok(winRemoval.includes(`resend, ${environment}, project ${ref.projectId}`));
    assert.ok(winRemoval.includes("RequestVerificationForWindowAsync"));
    assert.ok(winRemoval.includes("0 { $script:resultCode = 0 }  # Verified"));
    assert.ok(winRemoval.includes("$form.AcceptButton = $noButton"));

    for (const [Plane, helper, decode] of [
      [MacOSHumanPlane, MACOS_OSASCRIPT_PATH, (request) => request.args.at(-1)],
      [WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, (request) => decodeWindowsHelperScript(request.args.at(-1))]
    ]) {
      for (const [code, saved, removed] of [[0, "saved", "approved"], [2, "cancelled", "declined"], [10, "unavailable", "unavailable"], [null, "unavailable", "unavailable"]]) {
        const requests = [];
        const plane = new Plane(helper, async (request) => { requests.push(request); return code; });
        assert.equal(await plane.askSecret(ref), saved);
        assert.equal(await plane.askRemoval({ ...ref, kind: "secret" }), removed);
        assert.equal(requests.length, 2);
        assert.ok(decode(requests[0]).includes(account));
        for (const request of requests) {
          assert.equal(request.stdio, "ignore");
          assert.equal(request.shell, false);
          assert.ok(decode(request).includes(`${Plane === WindowsHumanPlane && request === requests[0] ? "App environment" : "Environment"}: ${environment}`));
          assert.ok(!Object.hasOwn(request.env, "RESEND_API_KEY"));
        }
      }
    }
  }

  const complete = { ...legacy, service: "resend", environment: "preview" };
  const invalid = [
    { ...legacy, service: "resend" }, { ...legacy, environment: "preview" },
    ...[undefined, null, "", "staging", "Preview", "preview\nproduction", "preview|production", "preview'; throw 'injected", { toString: () => "preview" }]
      .map((environment) => ({ ...complete, environment })),
    { ...complete, service: "other" }, { ...complete, service: "resend\nproduction" },
    { ...complete, name: "OTHER_API_KEY" },
    { ...complete, scope: "user", projectId: null, projectDir: null },
    { ...complete, projectId: "0123456789abcdef|production" },
    { ...complete, projectDir: "/project\nEnvironment: production" }
  ];
  for (const ref of invalid) {
    for (const [save, remove] of builders) {
      assert.throws(() => save(ref));
      assert.throws(() => remove({ ...ref, kind: "secret" }));
    }
    for (const [Plane, helper] of [[MacOSHumanPlane, MACOS_OSASCRIPT_PATH], [WindowsHumanPlane, WINDOWS_POWERSHELL_PATH]]) {
      let launched = false;
      const plane = new Plane(helper, async () => { launched = true; return 0; });
      await assert.rejects(() => plane.askSecret(ref));
      await assert.rejects(() => plane.askRemoval({ ...ref, kind: "secret" }));
      assert.equal(launched, false, "malformed identity must fail before a helper launches");
    }
  }

  for (const ref of [legacy, { ...legacy, scope: "user", projectId: null, projectDir: null }]) {
    for (const [save, remove] of builders) {
      assert.ok(save(ref).includes(`v1|${ref.scope}|${ref.projectId ?? "-"}|RESEND_API_KEY`));
      for (const script of [save(ref), remove({ ...ref, kind: "secret" })]) {
        assert.ok(!script.includes("Service: resend"));
        assert.ok(!script.includes("Environment:"));
        assert.ok(!script.includes("v2|credential"));
      }
    }
    assert.ok(buildWindowsSecretInputScript(ref).includes("Size(480, 282)"));
    assert.ok(buildWindowsSecretInputScript(ref).includes("Size(444, 56)"));
  }
  await runConnectionApprovalTests();
  console.log("Environment Human Plane scripts and fake-launcher tests passed (no native acceptance)");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runEnvironmentHumanPlaneTests();
}
