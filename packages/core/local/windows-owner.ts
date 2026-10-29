import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, win32 } from "node:path";
import type { Readable, Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { resolveWindowsHelperScratch, resolveWindowsPowerShell } from "../human/windows.js";

/** Private, byte-bearing launch material. Never serialize into public results or history. */
export interface WindowsLocalOwnerConfig {
  version: 1;
  projectDir: string;
  artifactPath: string;
  interpreterPath: string;
  artifactSha256: string;
  interpreterSha256: string;
  maxDurationMs: number;
  parentPid: number;
}

export type WindowsLocalOwner = ChildProcessByStdio<Writable, Readable, null>;

const ROOT = String.raw`C:\Windows`;
const SYSTEM_PATH = ["System32", "", "System32\\Wbem", "System32\\WindowsPowerShell\\v1.0"]
  .map((part) => win32.join(ROOT, part)).join(";");

/**
 * Fixed helper only. Config is sent once through private stdin, never command arguments.
 * Caller must consume exact READY, send {secret}, consume CREATED, revalidate, send RELEASE,
 * consume STARTED, and keep stdin open. CANCEL or EOF stops ownership. This primitive does
 * not approve anything or turn on the development feature. No untrusted source interpolation.
 */
export function spawnWindowsLocalOwner(config: WindowsLocalOwnerConfig): WindowsLocalOwner {
  let scratch: string | undefined;
  try {
    const keys = ["version", "projectDir", "artifactPath", "interpreterPath", "artifactSha256", "interpreterSha256", "maxDurationMs", "parentPid"];
    if (!config || Object.keys(config).length !== keys.length || keys.some((key) => !Object.hasOwn(config, key)) ||
        config.version !== 1 || !Number.isInteger(config.maxDurationMs) || config.maxDurationMs < 1_000 ||
        config.maxDurationMs > 1_800_000 || !Number.isInteger(config.parentPid) || config.parentPid !== process.pid ||
        typeof config.artifactSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.artifactSha256) ||
        typeof config.interpreterSha256 !== "string" || !/^[a-f0-9]{64}$/.test(config.interpreterSha256) ||
        [config.projectDir, config.artifactPath, config.interpreterPath].some((path) => typeof path !== "string" || path.length > 1_024 || /[\x00-\x1f]/.test(path))) {
      throw new Error();
    }
    if (process.platform !== "win32") throw new Error();
    const executable = resolveWindowsPowerShell();
    const trusted = resolveWindowsHelperScratch();
    if (!executable || !trusted) throw new Error();
    scratch = mkdtempSync(join(trusted.root, "api-key-case-local-owner-"));
    const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(buildWindowsLocalOwnerScript(), "utf16le").toString("base64")], {
      cwd: win32.dirname(executable),
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      // libuv fills these special names from the parent unless explicitly supplied.
      // Compiler temp contains only fixed source, never config, hashes, or credentials.
      env: {
        SystemRoot: ROOT, WINDIR: ROOT, SYSTEMDRIVE: "C:", PATH: SYSTEM_PATH,
        PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: win32.join(ROOT, "System32", "cmd.exe"),
        TEMP: scratch, TMP: scratch, USERPROFILE: trusted.home,
        HOMEDRIVE: trusted.home.slice(0, 2), HOMEPATH: trusted.home.slice(2)
      }
    });
    const scratchToRemove = scratch;
    child.once("close", () => { try { rmSync(scratchToRemove, { recursive: true, force: true }); } catch { /* Secret-free compiler scratch only. */ } });
    // Do not let platform errors carrying invocation details become unhandled errors.
    // The controller still receives these events and maps them to a closed unknown state.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({
      version: config.version, projectDir: config.projectDir, artifactPath: config.artifactPath,
      interpreterPath: config.interpreterPath, artifactSha256: config.artifactSha256,
      interpreterSha256: config.interpreterSha256, maxDurationMs: config.maxDurationMs, parentPid: config.parentPid
    })}\n`);
    return child;
  } catch {
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* No value-bearing files. */ } }
    throw new Error("Local application ownership unavailable.");
  }
}

/** Fixed C# source is exported for independent compilation and Windows synthetic acceptance. */
export const WINDOWS_LOCAL_OWNER_NATIVE_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;

public static class AkcLocalOwner {
  const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258, INHERIT = 1;
  const uint KILL_ON_JOB_CLOSE = 0x2000;
  const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_NO_WINDOW = 0x08000000;
  const int EXTENDED_LIMITS = 9, BASIC_ACCOUNTING = 1;
  static readonly IntPtr INVALID = new IntPtr(-1);
  static readonly string SafePath = @"C:\Windows\System32;C:\Windows;C:\Windows\System32\Wbem;C:\Windows\System32\WindowsPowerShell\v1.0";
  static StreamReader input;
  static Stopwatch clock;
  static int duration = 10000;
  static IntPtr parent, job, rootProcess, rootThread;
  static readonly List<IntPtr> directories = new List<IntPtr>();
  static readonly HashSet<string> pinnedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static FileStream artifact, interpreter;

  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int nLength; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
    public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long userTime, kernelTime, periodUserTime, periodKernelTime;
    public uint faults, totalProcesses, activeProcesses, terminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public IntPtr reserved, desktop, title; public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo basic; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
    public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr handle, int type, ref ExtendedLimits value, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr handle, int type, ref Accounting value, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr handle, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr file, out FileInfo information);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetLongPathNameW(string path, StringBuilder result, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);

  static void Check(bool value) { if (!value) throw new InvalidOperationException(); }
  static void NonInheritable(IntPtr handle) {
    Check(handle != IntPtr.Zero && handle != INVALID);
    uint flags; Check(SetHandleInformation(handle, INHERIT, 0));
    Check(GetHandleInformation(handle, out flags) && (flags & INHERIT) == 0);
  }
  static void Emit(string status) { Console.Out.Write(status + "\n"); Console.Out.Flush(); }
  static string ReadLine() {
    StringBuilder line = new StringBuilder(); int c;
    while ((c = input.Read()) >= 0) {
      if (c == 10) return line.ToString();
      Check(c != 13 && c != 0 && line.Length < 16384); line.Append((char)c);
    }
    Check(line.Length == 0); return null;
  }
  static string Interrupt() {
    if (parent != IntPtr.Zero) {
      uint state = WaitForSingleObject(parent, 0);
      if (state == WAIT_OBJECT_0) return "PARENT_LOST";
      Check(state == WAIT_TIMEOUT);
    }
    if (clock.ElapsedMilliseconds >= duration) return "EXPIRED";
    return null;
  }
  sealed class Stopped : Exception { public readonly string status; public Stopped(string value) { status = value; } }
  static void Guard() { string reason = Interrupt(); if (reason != null) throw new Stopped(reason); }
  static string NextLine() {
    Task<string> pending = Task.Factory.StartNew(new Func<string>(ReadLine));
    while (true) {
      Guard();
      if (pending.IsCompleted) {
        string line = pending.GetAwaiter().GetResult();
        if (line == null || line == "CANCEL") throw new Stopped("CANCELLED");
        return line;
      }
      Thread.Sleep(20);
    }
  }

  // A small strict object parser: strings and decimal integers only; reject duplicate/extra
  // fields, arrays, nested values, floats, unbounded input and malformed UTF-8. No diagnostics.
  sealed class ObjectReader {
    readonly string source; int index;
    public ObjectReader(string text) { source = text; }
    void Space() { while (index < source.Length && (source[index] == ' ' || source[index] == '\t')) index++; }
    char Take() { Check(index < source.Length); return source[index++]; }
    string Text() {
      Check(Take() == '"'); StringBuilder result = new StringBuilder();
      while (true) {
        char c = Take(); if (c == '"') return result.ToString(); Check(c >= 32);
        if (c == '\\') {
          c = Take();
          if (c == 'u') { Check(index + 4 <= source.Length); c = (char)int.Parse(source.Substring(index, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture); index += 4; }
          else if (c == 'n') c = '\n'; else if (c == 'r') c = '\r'; else if (c == 't') c = '\t';
          else if (c == 'b') c = '\b'; else if (c == 'f') c = '\f';
          else Check(c == '"' || c == '\\' || c == '/');
        }
        result.Append(c);
      }
    }
    public Dictionary<string,object> Read() {
      Dictionary<string,object> values = new Dictionary<string,object>(StringComparer.Ordinal);
      Space(); Check(Take() == '{'); Space();
      if (index < source.Length && source[index] == '}') { index++; Space(); Check(index == source.Length); return values; }
      while (true) {
        string key = Text(); Space(); Check(Take() == ':'); Space(); Check(index < source.Length);
        object value;
        if (source[index] == '"') value = Text();
        else {
          int start = index; while (index < source.Length && source[index] >= '0' && source[index] <= '9') index++;
          Check(index > start && (index - start == 1 || source[start] != '0'));
          value = long.Parse(source.Substring(start, index - start), CultureInfo.InvariantCulture);
        }
        values.Add(key, value); Space(); char ending = Take(); if (ending == '}') break; Check(ending == ','); Space();
      }
      Space(); Check(index == source.Length); return values;
    }
  }
  static string StringValue(Dictionary<string,object> values, string key) { return (string)values[key]; }
  static long NumberValue(Dictionary<string,object> values, string key) { return (long)values[key]; }
  static string PathValue(Dictionary<string,object> values, string key) {
    string path = StringValue(values, key);
    Check(path.Length >= 3 && path.Length <= 1024 && char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\');
    Check(path.IndexOf('/', 0) < 0 && path.IndexOf(':', 2) < 0 && path.IndexOf('"') < 0);
    foreach (char c in path) Check(c >= 32);
    foreach (string component in path.Substring(3).Split('\\')) Check(component.Length > 0 && !component.EndsWith(".") && !component.EndsWith(" "));
    // .NET Framework expands existing 8.3 components in GetFullPath. Compare
    // physical spellings while retaining the lexical checks and pinned identities.
    Check(String.Equals(PhysicalPath(Path.GetFullPath(path)), PhysicalPath(path), StringComparison.OrdinalIgnoreCase));
    return path;
  }
  // Project/ref metadata retains the caller's established realpath spelling. Expansion
  // here is only a physical comparison, so normal 8.3 aliases are not mistaken for a
  // replaced file. Pinned directory handles and reparse rejection remain mandatory.
  static string PhysicalPath(string path) {
    StringBuilder result = new StringBuilder(2048); uint size = GetLongPathNameW(path, result, 2048);
    Check(size > 0 && size < 2048); return result.ToString();
  }
  static void Identity(IntPtr handle, string expected, bool directory) {
    FileInfo info; Check(GetFileInformationByHandle(handle, out info));
    Check((info.attributes & 0x400) == 0 && ((info.attributes & 0x10) != 0) == directory);
    StringBuilder actual = new StringBuilder(2048); uint size = GetFinalPathNameByHandleW(handle, actual, 2048, 0);
    Check(size > 0 && size < 2048);
    Check(String.Equals(actual.ToString(), @"\\?\" + PhysicalPath(expected), StringComparison.OrdinalIgnoreCase));
  }
  static void PinDirectory(string path) {
    if (pinnedDirectories.Contains(path)) return;
    string ancestor = Path.GetDirectoryName(path.TrimEnd('\\'));
    if (!String.IsNullOrEmpty(ancestor)) PinDirectory(ancestor.Length == 2 ? ancestor + "\\" : ancestor);
    SecurityAttributes attributes = new SecurityAttributes(); attributes.nLength = Marshal.SizeOf(typeof(SecurityAttributes));
    // Directories deny deletion/rename while allowing unrelated child-file activity.
    IntPtr handle = CreateFileW(path, 0x80, 3, ref attributes, 3, 0x02200000, IntPtr.Zero);
    Check(handle != INVALID); directories.Add(handle); NonInheritable(handle); Identity(handle, path, true); pinnedDirectories.Add(path);
  }
  static FileStream LockFile(string path, string expectedHash) {
    Check(expectedHash.Length == 64);
    foreach (char c in expectedHash) Check((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
    PinDirectory(Path.GetDirectoryName(path));
    FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
    try {
      NonInheritable(file.SafeFileHandle.DangerousGetHandle()); Identity(file.SafeFileHandle.DangerousGetHandle(), path, false);
      using (SHA256 hash = SHA256.Create()) {
        byte[] digest = hash.ComputeHash(file); int different = 0;
        for (int i = 0; i < digest.Length; i++) different |= digest[i] ^ Convert.ToByte(expectedHash.Substring(i * 2, 2), 16);
        Array.Clear(digest, 0, digest.Length); Check(different == 0);
      }
      file.Position = 0; return file;
    } catch { file.Dispose(); throw; }
  }
  static void CreateOwned(string cwd, string application, string script, string secret) {
    IntPtr list = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero, nul = IntPtr.Zero;
    bool initialized = false; int environmentBytes = 0;
    try {
      job = CreateJobObjectW(IntPtr.Zero, null); NonInheritable(job);
      ExtendedLimits limits = new ExtendedLimits(); limits.basic.flags = KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, EXTENDED_LIMITS, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
      SecurityAttributes inherit = new SecurityAttributes(); inherit.nLength = Marshal.SizeOf(typeof(SecurityAttributes)); inherit.inherit = true;
      nul = CreateFileW("NUL", 0xC0000000, 3, ref inherit, 3, 0, IntPtr.Zero); Check(nul != INVALID);
      IntPtr size = IntPtr.Zero;
      Check(!InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size) && Marshal.GetLastWin32Error() == 122);
      Check(size.ToInt64() > 0 && size.ToInt64() <= 1048576);
      list = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(list, 2, 0, ref size)); initialized = true;
      jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
      handles = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(handles, nul);
      // Job assignment is ATOMIC with creation. Never add an AssignProcessToJobObject fallback.
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x0002000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      Check(UpdateProcThreadAttribute(list, 0, new IntPtr(0x00020002), handles, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      string block = "NODE_ENV=development\0PATH=" + SafePath + "\0RESEND_API_KEY=" + secret + "\0SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0\0";
      environmentBytes = checked((block.Length + 1) * 2); environment = Marshal.StringToHGlobalUni(block); block = null;
      StartupInfoEx startup = new StartupInfoEx(); startup.basic.cb = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.basic.flags = 0x100; startup.basic.stdin = nul; startup.basic.stdout = nul; startup.basic.stderr = nul; startup.attributes = list;
      ProcessInfo created; Guard();
      // Paths disallow quotes and trailing separators, so these exactly two quoted argv tokens
      // cannot introduce a switch, command, URL or caller-controlled argument.
      Check(CreateProcessW(application, new StringBuilder("\"" + application + "\" \"" + script + "\""), IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, environment, cwd, ref startup, out created));
      rootProcess = created.process; rootThread = created.thread; NonInheritable(rootProcess); NonInheritable(rootThread);
    } finally {
      if (environment != IntPtr.Zero) { for (int i = 0; i < environmentBytes; i++) Marshal.WriteByte(environment, i, 0); Marshal.FreeHGlobal(environment); }
      if (initialized) DeleteProcThreadAttributeList(list);
      if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs);
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (nul != IntPtr.Zero && nul != INVALID) CloseHandle(nul);
    }
  }
  static string ObserveRoot() {
    Task<string> pending = Task.Factory.StartNew(new Func<string>(ReadLine));
    while (true) {
      Guard();
      if (pending.IsCompleted) {
        string line = pending.GetAwaiter().GetResult();
        if (line == null || line == "CANCEL") return "CANCELLED";
        throw new InvalidOperationException();
      }
      uint state = WaitForSingleObject(rootProcess, 0);
      if (state == WAIT_OBJECT_0) { uint code; Check(GetExitCodeProcess(rootProcess, out code)); return code == 0 ? "EXITED" : "FAILED"; }
      Check(state == WAIT_TIMEOUT); Thread.Sleep(20);
    }
  }
  static bool StopTree() {
    if (job == IntPtr.Zero || job == INVALID) return rootProcess == IntPtr.Zero;
    if (!TerminateJobObject(job, 1)) return false;
    Stopwatch stop = Stopwatch.StartNew();
    while (stop.ElapsedMilliseconds < 10000) {
      Accounting accounting = new Accounting();
      if (!QueryInformationJobObject(job, BASIC_ACCOUNTING, ref accounting, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) return false;
      if (accounting.activeProcesses == 0) return true;
      Thread.Sleep(10);
    }
    return false;
  }
  public static void Run() {
    string status = "UNKNOWN";
    try {
      input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true), false, 1024);
      clock = Stopwatch.StartNew();
      Dictionary<string,object> config = new ObjectReader(NextLine()).Read(); Check(config.Count == 8);
      Check(NumberValue(config, "version") == 1);
      long requestedDuration = NumberValue(config, "maxDurationMs"); Check(requestedDuration >= 1000 && requestedDuration <= 1800000); duration = (int)requestedDuration;
      long pid = NumberValue(config, "parentPid"); Check(pid > 0 && pid <= Int32.MaxValue && pid != Process.GetCurrentProcess().Id);
      parent = OpenProcess(0x00100000, false, (uint)pid); NonInheritable(parent); Guard();
      string cwd = PathValue(config, "projectDir"), script = PathValue(config, "artifactPath"), application = PathValue(config, "interpreterPath");
      Check(PhysicalPath(script).StartsWith(PhysicalPath(cwd) + "\\", StringComparison.OrdinalIgnoreCase) && script.EndsWith(".cjs", StringComparison.OrdinalIgnoreCase));
      Check(String.Equals(Path.GetFileName(application), "node.exe", StringComparison.OrdinalIgnoreCase));
      PinDirectory(cwd); artifact = LockFile(script, StringValue(config, "artifactSha256")); interpreter = LockFile(application, StringValue(config, "interpreterSha256"));
      config = null; Guard(); Emit("READY");
      Dictionary<string,object> value = new ObjectReader(NextLine()).Read(); Check(value.Count == 1);
      string secret = StringValue(value, "secret"); Check(secret.Length > 0 && secret.Length <= 4096);
      foreach (char c in secret) Check(c != 0 && c != '\r' && c != '\n');
      Guard(); CreateOwned(cwd, application, script, secret); value.Clear(); value = null; secret = null;
      Guard(); Emit("CREATED"); Check(NextLine() == "RELEASE"); Guard();
      Check(ResumeThread(rootThread) == 1); Emit("STARTED"); status = ObserveRoot();
    } catch (Stopped stopped) { status = stopped.status; } catch { status = "UNKNOWN"; }
    finally {
      try { if (!StopTree()) status = "UNKNOWN"; } catch { status = "UNKNOWN"; }
      // KILL_ON_JOB_CLOSE also covers abrupt helper termination at every instruction,
      // including before CreateProcessW returns and while the root is suspended.
      if (job != IntPtr.Zero && job != INVALID) { if (!CloseHandle(job)) status = "UNKNOWN"; job = IntPtr.Zero; }
      if (rootThread != IntPtr.Zero) CloseHandle(rootThread);
      if (rootProcess != IntPtr.Zero) CloseHandle(rootProcess);
      if (parent != IntPtr.Zero && parent != INVALID) CloseHandle(parent);
      if (artifact != null) artifact.Dispose(); if (interpreter != null) interpreter.Dispose();
      foreach (IntPtr directory in directories) CloseHandle(directory);
    }
    try { Emit(status); } catch { /* Broken private output pipe cannot extend ownership. */ }
  }
}
`;

/** Compression keeps the fixed UTF-16 -EncodedCommand below Windows' command-line limit. */
export function buildWindowsLocalOwnerScript(): string {
  const compressed = gzipSync(Buffer.from(WINDOWS_LOCAL_OWNER_NATIVE_SOURCE, "utf8"), { level: 9 }).toString("base64");
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "$WarningPreference = 'SilentlyContinue'",
    "$VerbosePreference = 'SilentlyContinue'",
    "$DebugPreference = 'SilentlyContinue'",
    "$InformationPreference = 'SilentlyContinue'",
    "try {",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    `$bytes = [Convert]::FromBase64String('${compressed}')`,
    "$memory = New-Object System.IO.MemoryStream(,$bytes)",
    "$gzip = New-Object System.IO.Compression.GzipStream($memory, [System.IO.Compression.CompressionMode]::Decompress)",
    "$reader = New-Object System.IO.StreamReader($gzip, [System.Text.Encoding]::UTF8)",
    "$source = $reader.ReadToEnd(); $reader.Dispose()",
    "Add-Type -TypeDefinition $source -ErrorAction Stop | Out-Null",
    "[AkcLocalOwner]::Run()",
    "} catch { [Console]::Out.Write(\"UNKNOWN`n\"); [Console]::Out.Flush() }"
  ].join("\n");
}
