// Developer acceptance only. Never shipped as a secret getter or runtime service.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const environments = ["development", "preview", "production"];
const statuses = ["registered", "missing", "saved", "removed", "cancelled", "unavailable", "already-registered", "metadata-unavailable"];

/** Test seam for the fixed acceptance sequence; no value argument or value read. */
export async function acceptEnvironmentSlots({ invoke, tell, confirmLayout, record }) {
  const evidence = { schemaVersion: 1, kind: "windows-environment-acceptance", status: "in-progress", steps: [], layoutConfirmed: false };
  const persist = () => record(structuredClone(evidence));
  const check = (id, env, action, expected, force = false) => {
    const args = ["connection", "credential", action, "--service", "resend", "--env", env, "--json"];
    if (force) args.push("--force");
    const r = invoke(args);
    let value;
    try { value = JSON.parse(r.stdout); } catch { throw new Error("unexpected-result"); }
    if (!value || Object.keys(value).sort().join(",") !== "environment,service,status" ||
        value.service !== "resend" || value.environment !== env || !statuses.includes(value.status)) throw new Error("unexpected-result");
    const exit = expected === "cancelled" ? 4 : expected === "missing" ? 1 : 0;
    const ok = !r.error && r.status === exit && value.status === expected;
    evidence.steps.push({ id, environment: env, expected, actual: value.status, passed: ok }); persist();
    if (!ok) throw new Error("status-mismatch");
  };
  persist();
  try {
    // Each invocation is a fresh Node process; none reads or prints a value.
    for (const env of environments) check(`empty-${env}`, env, "check", "missing");
    tell("① 開発用の保存画面です。環境 development とテスト用プロジェクトを確認し、test-dev-52 と入力して保存してください。本物のキーは使いません。");
    check("save-development", "development", "save", "saved");
    check("development-present", "development", "check", "registered");
    check("production-still-missing", "production", "check", "missing");
    tell("② 本番用の保存画面です。環境 production を確認し、test-prod-52 と入力して保存してください。");
    check("save-production", "production", "save", "saved");
    tell("③ 開発用の上書き画面です。何も入力せず、キャンセルしてください。");
    check("cancel-overwrite", "development", "save", "cancelled", true);
    check("after-cancel-overwrite", "development", "check", "registered");
    tell("④ 開発用の削除画面です。今回はキャンセルしてください。");
    check("cancel-removal", "development", "remove", "cancelled");
    check("after-cancel-removal", "development", "check", "registered");
    tell("⑤ 開発用のテスト値を削除します。環境 development を確認し、削除を選んで Windows の本人確認を完了してください。");
    check("remove-development", "development", "remove", "removed");
    check("development-now-missing", "development", "check", "missing");
    check("production-survived", "production", "check", "registered");
    check("preview-still-missing", "preview", "check", "missing");
    tell("⑥ 本番用のテスト値も片付けます。環境 production を確認し、削除と Windows の本人確認を完了してください。");
    check("cleanup-production", "production", "remove", "removed");
    for (const env of environments) check(`final-${env}`, env, "check", "missing");
    evidence.layoutConfirmed = await confirmLayout() === true;
    evidence.status = evidence.layoutConfirmed ? "passed" : "layout-unconfirmed";
  } catch {
    // Do not serialize raw subprocess output, exceptions, or guessed success.
    evidence.status = "failed";
  }
  persist();return evidence;
}

export function candidateRevision(root, run = spawnSync) {
  const options = {cwd:root, encoding:"utf8", windowsHide:true, shell:false};
  const revision = run("git", ["rev-parse", "HEAD"], options);
  if (revision.status !== 0 || typeof revision.stdout !== "string" || !/^[0-9a-f]{40}$/.test(revision.stdout.trim())) return null;
  const dirty = run("git", ["diff", "--quiet", "HEAD", "--", "packages", "tools/accept-environment-windows.mjs", "package.json", "package-lock.json", "tsconfig.json"], options);
  return dirty.status === 0 ? revision.stdout.trim() : null;
}

export async function main() {
  if (process.platform !== "win32" || Number(release().split(".")[2]) < 22000 || !process.stdin.isTTY) {
    console.error("Windows 11 と対話型の PowerShell が必要です。OS の本人確認を代行する機能はありません。");return 1;
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const revision = candidateRevision(root);
  if (!revision) {
    console.error("候補の版または変更状態を確認できません。既存の変更はそのままにして、案内された専用の作業場所から実行してください。");return 1;
  }
  const project = mkdtempSync(join(tmpdir(), "api-key-case-native-"));
  writeFileSync(join(project,"app.ts"), "process.env.RESEND_API_KEY;\n");
  writeFileSync(join(project,".gitignore"), ".env\n.env.*\n!.env.example\n");
  const cli = join(root,"dist","cli","index.js"), reportPath = join(project,"acceptance-result.json");
  const rl = createInterface({input:process.stdin,output:process.stdout});
  console.log("環境分離の確認を始めます。6回の画面操作だけお願いします。既存プロジェクトのキーには触れません。");
  console.log(`今回だけのテスト先: ${project}`);
  console.log("表示倍率は変更しません。途中で失敗した場合は、テスト先を消さず結果ファイルを返してください。");
  let scale = "unknown";
  try {
    const answer = (await rl.question("今の表示倍率は 100 / 125 / 150 / 175 / 200 のどれですか？ 不明なら Enter: ")).trim();
    if (["100","125","150","175","200"].includes(answer)) scale = answer;
    const result = await acceptEnvironmentSlots({
      invoke:args=>spawnSync(process.execPath,[cli,...args,project],{cwd:root,env:{...process.env,DO_NOT_TRACK:"1"},encoding:"utf8",timeout:600000,maxBuffer:1024*1024,windowsHide:true,shell:false}),
      tell:message=>console.log(`\n${message}`),
      confirmLayout:async()=>/^(y|yes)$/i.test((await rl.question("各画面でサービス・環境・テスト先を読めて、文字切れはありませんでしたか？ y/n: ")).trim()),
      record:data=>writeFileSync(reportPath,JSON.stringify({...data,candidate:revision,windowsBuild:release(),nodeVersion:process.version,displayScale:scale},null,2),{mode:0o600})
    });
    console.log(`\n結果: ${result.status === "passed" ? "確認できました" : "未完了です"}`);
    console.log(`この結果ファイルを dot に添付してください: ${reportPath}`);
    console.log("ファイルには状態だけを記録しています。入力値や本人確認情報は記録していません。");
    return result.status === "passed" ? 0 : 1;
  } finally { rl.close(); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) process.exitCode=await main();
