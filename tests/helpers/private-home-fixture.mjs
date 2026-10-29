// Disposable test directories only; never repairs a real user's product data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function privateHomeFixture(prefix) {
  const home = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), prefix)));
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; try {
      $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(home).toString("base64")}'));
      $me=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $a=Get-Acl -LiteralPath $p; $a.SetOwner($me); $a.SetAccessRuleProtection($true,$false);
      foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-544')) {
        $r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $a.AddAccessRule($r)
      }; Set-Acl -LiteralPath $p -AclObject $a
    } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }`;
    const result = spawnSync(String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, encoding: "utf8", timeout: 60_000,
        cwd: String.raw`C:\Windows\System32`,
        // A pwsh parent can supply its PS7 module path to Windows PowerShell 5.
        // Match the product's fixed native environment instead of importing it.
        env: { SystemRoot: String.raw`C:\Windows`, WINDIR: String.raw`C:\Windows`, PATH: String.raw`C:\Windows\System32` } });
    assert.equal(result.status, 0, `disposable fixture ACL setup: ${result.error?.code ?? result.stderr}`);
  }
  return home;
}
