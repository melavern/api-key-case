// Transport regression only. No dialogs, credentials, approvals or provider calls.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {WindowsHumanPlane, WINDOWS_POWERSHELL_PATH, WINDOWS_HELPER_COMMAND_MAX_CHARS,
  encodeWindowsHelperCommand, buildWindowsApprovalScript, buildWindowsRemovalScript} from '../dist/core/human/windows.js';

export function decodeWindowsHelperScript(encoded) {
  const source = Buffer.from(encoded, 'base64').toString('utf16le');
  const packed = source.match(/\$akcBytes = \[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
  return packed ? gunzipSync(Buffer.from(packed[1], 'base64')).toString('utf8') : source;
}

export async function runWindowsHelperCommandTests() {
  const root = mkdtempSync(join(tmpdir(), 'akc-helper-command-'));
  try {
    const plan = {name:'CLERK_SECRET_KEY',scope:'project',projectId:'0123456789abcdef',target:'cloudflare',env:'development',force:false,
      projectDir:'C:/synthetic-only/project',destination:'synthetic Worker',cliPath:'C:/synthetic-only/wrangler.cmd',
      command:'wrangler versions secret put CLERK_SECRET_KEY --env development',preCommands:[],trustState:'always-approve',
      connectionSource:{credentialVersion:2,service:'clerk',operation:'cloudflare-version-preparation',environment:'development',credentialRevision:'2026-10-04T00:00:00.000Z'}};
    const approval = buildWindowsApprovalScript(plan);
    const oldLength = Buffer.from(approval, 'utf16le').toString('base64').length;
    assert.ok(oldLength > 32767, 'reproduce the previous oversized Clerk approval');
    const packed = encodeWindowsHelperCommand(approval);
    assert.ok(packed.length < WINDOWS_HELPER_COMMAND_MAX_CHARS - 1000);
    assert.equal(decodeWindowsHelperScript(packed), approval, 'preserve every Unicode character and verification branch');
    assert.equal(decodeWindowsHelperScript(encodeWindowsHelperCommand("exit 2")), 'exit 2');
    for (const code of [0, 2, 10, null]) {
      const requests = [];
      const plane = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async r => {requests.push(r); return code;}, () => ({root,home:root}));
      assert.equal(await plane.askApproval(plan), code === 0 ? 'approved' : code === 2 ? 'declined' : 'unavailable');
      const removal = {kind:'secret',name:'CLERK_SECRET_KEY',scope:'project',projectId:plan.projectId,projectDir:plan.projectDir,
        service:'clerk',environment:'development'};
      assert.equal(await plane.askRemoval(removal), code === 0 ? 'approved' : code === 2 ? 'declined' : 'unavailable');
      for (const [i, r] of requests.entries()) {
        assert.equal(r.executable, WINDOWS_POWERSHELL_PATH); assert.equal(r.stdio, 'ignore');
        assert.equal(r.shell, false); assert.equal(r.detached, false); assert.equal(r.windowsHide, false);
        assert.ok(r.executable.length + r.args.join(' ').length + 3 < WINDOWS_HELPER_COMMAND_MAX_CHARS);
        assert.equal(decodeWindowsHelperScript(r.args.at(-1)), i === 0 ? approval : buildWindowsRemovalScript(removal));
        assert.equal('input' in r, false); assert.equal('scriptFile' in r, false);
      }
    }
    let launches = 0;
    const refusal = new WindowsHumanPlane(WINDOWS_POWERSHELL_PATH, async () => {launches++;return 0;}, () => ({root,home:root}));
    assert.equal(await refusal.askApproval({...plan, destination:randomBytes(30000).toString('base64')}), 'unavailable');
    assert.equal(launches, 0, 'still oversized generated code must not spawn or fall back');
    assert.deepEqual(readdirSync(root), [], 'owned helper scratch removed without writing source files');
    if (process.platform === 'win32') {
      const run = encoded => spawnSync(WINDOWS_POWERSHELL_PATH, ['-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',encoded],
        {cwd:'C:/Windows/System32/WindowsPowerShell/v1.0', env:{SystemRoot:'C:/Windows',WINDIR:'C:/Windows'},stdio:'ignore',windowsHide:true,shell:false,timeout:15000});
      const padding = '\n#' + ' '.repeat(15000);
      const harmless = "$literal = '日本語・引用符 '' と絵文字🔑'; if ($literal -ne [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + Buffer.from("日本語・引用符 ' と絵文字🔑", 'utf8').toString('base64') + "'))) { exit 13 }; exit 2" + padding;
      const prior = run(Buffer.from(harmless, 'utf16le').toString('base64'));
      assert.equal(prior.error?.code, 'ENAMETOOLONG');
      assert.equal(run(encodeWindowsHelperCommand(harmless)).status, 2, 'Windows decompression executes exact Unicode source');
      for (const source of ['throw \'synthetic failure\'', "$null = 'returns without explicit status'"]) {
        assert.equal(run(encodeWindowsHelperCommand(source + padding)).status, 10, 'bootstrap fails closed');
      }
      const wrapper = Buffer.from(encodeWindowsHelperCommand(harmless),'base64').toString('utf16le');
      const corrupt = wrapper.replace(/FromBase64String\('[A-Za-z0-9+/=]+'\)/, "FromBase64String('not-valid-base64!')");
      assert.equal(run(Buffer.from(corrupt,'utf16le').toString('base64')).status, 10);
      console.log(JSON.stringify({kind:'windows-helper-command-native',oldArgumentCharacters:oldLength,newArgumentCharacters:packed.length,oversizedRejected:true,unicodePreserved:true,failClosed:true}));
    }
    console.log('Windows helper command transport regression passed; no dialog/store/provider');
  } finally {rmSync(root,{recursive:true,force:true});}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await runWindowsHelperCommandTests();
