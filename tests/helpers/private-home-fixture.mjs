// Disposable test directories only; never repairs a real user's product data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ciOwnerPrepared = false;
function ciOwnerSetup() {
  if (ciOwnerPrepared || process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "Windows") return "";
  // GitHub's elevated runner may default newly created objects to Administrators.
  // Normalize only this disposable test Node process's TokenOwner to its existing
  // user SID. No user/group, privilege, machine policy or product guard changes.
  // https://learn.microsoft.com/windows/win32/api/winnt/ns-winnt-token_owner
  return `
    $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $PID";
    if($parent.ParentProcessId -ne ${process.pid}){throw 'Fixture must operate its direct Node parent only'}
    Add-Type -TypeDefinition @'
using System; using System.ComponentModel; using System.Diagnostics; using System.Runtime.InteropServices; using System.Security.Principal;
public static class AkcDisposableTokenOwner {
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr token,int kind,IntPtr info,uint length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Prepare(int pid) {
    using(var p=Process.GetProcessById(pid)) {
      if(p.ProcessName!="node")throw new Exception("Not the fixture Node process");
      IntPtr token; if(!OpenProcessToken(p.Handle,0x88,out token))throw new Win32Exception();
      try {
        SecurityIdentifier user;
        using(var current=WindowsIdentity.GetCurrent()) using(var identity=new WindowsIdentity(token)) {
          user=identity.User; if(!user.Equals(current.User))throw new Exception("Fixture user mismatch");
          if(user.Equals(identity.Owner))return;
        }
        var bytes=new byte[user.BinaryLength]; user.GetBinaryForm(bytes,0);
        IntPtr sid=Marshal.AllocHGlobal(bytes.Length),info=Marshal.AllocHGlobal(IntPtr.Size);
        try {
          Marshal.Copy(bytes,0,sid,bytes.Length); Marshal.WriteIntPtr(info,sid);
          if(!SetTokenInformation(token,4,info,(uint)IntPtr.Size))throw new Win32Exception();
          using(var check=new WindowsIdentity(token)) if(!user.Equals(check.Owner))throw new Exception("Fixture owner not applied");
        } finally {Marshal.FreeHGlobal(info);Marshal.FreeHGlobal(sid);}
      } finally {CloseHandle(token);}
    }
  }
}
'@
    [AkcDisposableTokenOwner]::Prepare(${process.pid});
  `;
}

export function privateHomeFixture(prefix) {
  const home = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), prefix)));
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; try {
      ${ciOwnerSetup()}
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
    ciOwnerPrepared = true;
  }
  return home;
}
