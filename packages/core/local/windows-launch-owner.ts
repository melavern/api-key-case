import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveWindowsHelperScratch, resolveWindowsPowerShell } from "../human/windows.js";
import { WINDOWS_LOCAL_OWNER_NATIVE_SOURCE, type WindowsLocalOwner } from "./windows-owner.js";
import { launchVariable, type LaunchProfile, type ProfileSnapshot } from "./profile-snapshot.js";

/** Private stdin configuration. Contains references only; no caller-controlled argv or env map. */
export function profileOwnerConfig(snapshot: ProfileSnapshot, profile: LaunchProfile): Record<string, string | number> {
  const config: Record<string, string | number> = { version: 2, projectDir: win32.normalize(snapshot.project), cwd: win32.normalize(snapshot.cwd),
    entry: profile.kind === "node-package-script" || profile.kind === "python-module" ? snapshot.entry : win32.normalize(snapshot.entry),
    kind: profile.kind, interpreterPath: win32.normalize(profile.runtimeIdentity.executable), maxDurationMs: profile.maxDurationSeconds * 1000,
    parentPid: process.pid, fileCount: snapshot.files.length, variableCount: snapshot.variables.length };
  snapshot.files.forEach((f, i) => { config[`file${i}`] = win32.normalize(f.path); config[`hash${i}`] = f.fingerprint; });
  snapshot.variables.forEach((name, i) => { config[`variable${i}`] = launchVariable(name); });
  return config;
}
// Share the audited Win32/job/strict-parser primitives without altering the legacy route.
// Boundaries are exact fixed source anchors; no user input is interpolated into C#.
function section(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2 || source.split(to).length !== 2) throw Error("Owner source unavailable.");
  return source.slice(source.indexOf(from), source.indexOf(to));
}
const legacySource = WINDOWS_LOCAL_OWNER_NATIVE_SOURCE.replaceAll("\r\n", "\n");
const shared = legacySource.slice(0, legacySource.indexOf("  static void CreateOwned("));
const createOwned = section(legacySource, "  static void CreateOwned(", "  static string ObserveRoot()")
  .replace("string script, string secret", "string commandLine, string block")
  .replace('      string block = "NODE_ENV=development\\0PATH=" + SafePath + "\\0RESEND_API_KEY=" + secret + "\\0SystemRoot=C:\\\\Windows\\0WINDIR=C:\\\\Windows\\0\\0";\n', "")
  .replace('new StringBuilder("\\\"" + application + "\\\" \\\"" + script + "\\\"")', "new StringBuilder(commandLine)");
const observe = section(legacySource, "  static string ObserveRoot()", "  public static void Run()");
if (createOwned.includes("RESEND_API_KEY") || createOwned.includes("+ script +") || !createOwned.includes("new StringBuilder(commandLine)")) throw Error("Owner source unavailable.");
export const WINDOWS_PROFILE_OWNER_SOURCE = (shared + createOwned + observe + String.raw`
  static readonly List<FileStream> selections = new List<FileStream>();
  static string Quote(string value) { Check(value.IndexOf('"') < 0 && !value.EndsWith("\\")); return "\"" + value + "\""; }
  static bool Variable(string value) {
    return System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[A-Za-z_][A-Za-z0-9_]{0,127}\z") &&
      !System.Text.RegularExpressions.Regex.IsMatch(value, @"^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|SYSTEMDRIVE|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP|NODE_.*|PYTHON.*|NPM_.*|LD_.*|DYLD_.*|__.*)$", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
  }
  static bool Within(string root, string path) { return String.Equals(PhysicalPath(root),PhysicalPath(path),StringComparison.OrdinalIgnoreCase) || PhysicalPath(path).StartsWith(PhysicalPath(root)+"\\",StringComparison.OrdinalIgnoreCase); }
  public static void Run() {
    string status = "UNKNOWN";
    try {
      input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false,true), false,1024); clock = Stopwatch.StartNew();
      Dictionary<string,object> config = new ObjectReader(NextLine()).Read(); Check(NumberValue(config,"version")==2);
      long fileCount = NumberValue(config,"fileCount"), count = NumberValue(config,"variableCount");
      Check(fileCount>=1 && fileCount<=16 && count>=1 && count<=128 && config.Count==10+2*fileCount+count);
      long requested = NumberValue(config,"maxDurationMs"); Check(requested>=1000 && requested<=7200000); duration=(int)requested;
      long pid=NumberValue(config,"parentPid"); Check(pid>0 && pid<=Int32.MaxValue && pid!=Process.GetCurrentProcess().Id);
      parent=OpenProcess(0x00100000,false,(uint)pid); NonInheritable(parent); Guard();
      string project=PathValue(config,"projectDir"), cwd=PathValue(config,"cwd"), application=PathValue(config,"interpreterPath");
      Check(Within(project,cwd)); PinDirectory(project); PinDirectory(cwd);
      string kind=StringValue(config,"kind"), entry=StringValue(config,"entry"), command=Quote(application);
      bool node=kind=="node-entry" || kind=="node-package-script";
      Check(node ? String.Equals(Path.GetFileName(application),"node.exe",StringComparison.OrdinalIgnoreCase) : String.Equals(Path.GetFileName(application),"python.exe",StringComparison.OrdinalIgnoreCase));
      for(int i=0;i<fileCount;i++) {
        string path=PathValue(config,"file"+i); if(i==0)Check(String.Equals(PhysicalPath(path),PhysicalPath(application),StringComparison.OrdinalIgnoreCase));
        selections.Add(LockFile(path,StringValue(config,"hash"+i)));
      }
      if(kind=="node-package-script") {
        Check(entry=="dev" || entry=="start"); string npm=Path.Combine(Path.GetDirectoryName(application),@"node_modules\npm\bin\npm-cli.js");
        Check(fileCount>=4 && String.Equals(PhysicalPath(PathValue(config,"file1")),PhysicalPath(npm),StringComparison.OrdinalIgnoreCase));
        command+=" "+Quote(npm)+" run "+entry;
      } else if(kind=="python-module") {
        Check(System.Text.RegularExpressions.Regex.IsMatch(entry,@"\A[A-Za-z_]\w*(\.[A-Za-z_]\w*)*\z")); command+=" -E -s -m "+entry;
      } else {
        Check(kind=="node-entry" || kind=="python-entry"); string path=PathValue(config,"entry"); Check(Within(project,path)); PinDirectory(Path.GetDirectoryName(path));
        SecurityAttributes attrs=new SecurityAttributes(); attrs.nLength=Marshal.SizeOf(typeof(SecurityAttributes));
        // Check a normal file without retaining a lock: saving/reloading source is allowed.
        IntPtr source=CreateFileW(path,0x80,7,ref attrs,3,0x00200000,IntPtr.Zero); Check(source!=INVALID);
        try{Identity(source,path,false);}finally{CloseHandle(source);}
        Check(node ? System.Text.RegularExpressions.Regex.IsMatch(path,@"\.(js|mjs|cjs)$",System.Text.RegularExpressions.RegexOptions.IgnoreCase) : path.EndsWith(".py",StringComparison.OrdinalIgnoreCase));
        command+=(node ? " " : " -E -s ")+Quote(path);
      }
      List<string> names=new List<string>(); HashSet<string> unique=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      for(int i=0;i<count;i++){string name=StringValue(config,"variable"+i);Check(Variable(name)&&unique.Add(name));names.Add(name);}
      config.Clear();config=null;Guard();Emit("READY");
      Dictionary<string,object> values=new ObjectReader(NextLine()).Read();Check(values.Count==count);
      SortedDictionary<string,string> env=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
      env.Add("PATH",Path.GetDirectoryName(application)+";"+Path.Combine(cwd,@"node_modules\.bin")+";"+SafePath);
      env.Add("SystemRoot",@"C:\Windows");env.Add("WINDIR",@"C:\Windows");env.Add("ComSpec",@"C:\Windows\System32\cmd.exe");env.Add("PATHEXT",".COM;.EXE;.BAT;.CMD");
      env.Add("NPM_CONFIG_LOGS_MAX","0");env.Add("NPM_CONFIG_LOGLEVEL","silent");env.Add("NPM_CONFIG_UPDATE_NOTIFIER","false");env.Add("NPM_CONFIG_AUDIT","false");env.Add("NPM_CONFIG_FUND","false");
      env.Add("NPM_CONFIG_USERCONFIG",@"C:\Windows\NUL");env.Add("NPM_CONFIG_GLOBALCONFIG",@"C:\Windows\System32\NUL");env.Add("NPM_CONFIG_SCRIPT_SHELL",@"C:\Windows\System32\cmd.exe");
      for(int i=0;i<count;i++) {string value=StringValue(values,"value"+i);Check(value.Length>0&&value.Length<=4096);foreach(char c in value)Check(c!=0&&c!='\r'&&c!='\n');env.Add(names[i],value);}
      StringBuilder builder=new StringBuilder();foreach(KeyValuePair<string,string> item in env){builder.Append(item.Key).Append('=').Append(item.Value).Append('\0');}builder.Append('\0');Check(builder.Length<30000);
      string block=builder.ToString();builder.Clear();env.Clear();values.Clear();values=null;Guard();CreateOwned(cwd,application,command,block);block=null;
      Guard();Emit("CREATED");Check(NextLine()=="RELEASE");Guard();Check(ResumeThread(rootThread)==1);Emit("STARTED");status=ObserveRoot();
    }catch(Stopped stopped){status=stopped.status;}catch{status="UNKNOWN";}
    finally {
      try{if(!StopTree())status="UNKNOWN";}catch{status="UNKNOWN";}
      if(job!=IntPtr.Zero&&job!=INVALID){if(!CloseHandle(job))status="UNKNOWN";job=IntPtr.Zero;}
      if(rootThread!=IntPtr.Zero)CloseHandle(rootThread);if(rootProcess!=IntPtr.Zero)CloseHandle(rootProcess);if(parent!=IntPtr.Zero&&parent!=INVALID)CloseHandle(parent);
      foreach(FileStream file in selections)file.Dispose();foreach(IntPtr directory in directories)CloseHandle(directory);
    }
    try{Emit(status);}catch{}
  }
}
`).replace("public static class AkcLocalOwner", "public static class AkcLaunchOwner")
  .replace("  static FileStream artifact, interpreter;\n", "")
  .replace("FileInfo info; Check(GetFileInformationByHandle(handle, out info));", "FileInfo info; Check(GetFileInformationByHandle(handle, out info)); Check(directory || info.links == 1);")
  .replace("line.Length < 16384", "line.Length < 1048576");

export function buildWindowsProfileOwnerScript(): string {
  const bytes = gzipSync(Buffer.from(WINDOWS_PROFILE_OWNER_SOURCE, "utf8"), { level: 9 }).toString("base64");
  return `$ErrorActionPreference='Stop'; try { [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $m=New-Object IO.MemoryStream(,[Convert]::FromBase64String('${bytes}')); $g=New-Object IO.Compression.GzipStream($m,[IO.Compression.CompressionMode]::Decompress); $r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8); $s=$r.ReadToEnd(); $r.Dispose(); Add-Type -TypeDefinition $s -ErrorAction Stop | Out-Null; [AkcLaunchOwner]::Run() } catch { [Console]::Out.Write("UNKNOWN\`n"); [Console]::Out.Flush() }`;
}
export function spawnWindowsProfileOwner(snapshot: ProfileSnapshot, profile: LaunchProfile): WindowsLocalOwner {
  if (process.platform !== "win32") throw Error("Application ownership unavailable.");
  const executable = resolveWindowsPowerShell(), trusted = resolveWindowsHelperScratch();
  if (!executable || !trusted) throw Error("Application ownership unavailable.");
  const scratch = mkdtempSync(join(trusted.root, "api-key-case-profile-owner-"));
  try {
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(buildWindowsProfileOwnerScript(), "utf16le").toString("base64")], {
      cwd: win32.dirname(executable), shell: false, detached: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", SYSTEMDRIVE: "C:", PATH: "C:\\Windows\\System32;C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD",
        ComSpec: "C:\\Windows\\System32\\cmd.exe", TEMP: scratch, TMP: scratch, USERPROFILE: trusted.home, HOMEDRIVE: trusted.home.slice(0, 2), HOMEPATH: trusted.home.slice(2) } });
    child.once("close", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch {} });
    child.on("error", () => {}); child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify(profileOwnerConfig(snapshot, profile)) + "\n"); return child;
  } catch { try { rmSync(scratch, { recursive: true, force: true }); } catch {} throw Error("Application ownership unavailable."); }
}
