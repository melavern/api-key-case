// Test only: operate one exact powershell.exe child of the supplied test PID.
// No credential/password or OS identity-verification control is read or operated.
import assert from "node:assert/strict";
const ps = s => "'" + s.replaceAll("'", "''") + "'";
export function buildMetadataDriver({ helperPid, ownerPid, caption, index = null, cancel = false, imagePath = null }) {
  assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0 && Number.isSafeInteger(ownerPid) && ownerPid > 0);
  assert.ok(["API Key Case - Confirm Binding", "API Key Case - Manage Binding", "API Key Case - Register Target", "API Key Case - Deploy Binding", "API Key Case - Register Launch Profile", "API Key Case - Launch Application", "API Key Case - Register Hosted Target"].includes(caption));
  assert.ok(index === null || Number.isInteger(index) && index >= 0 && index < 4096);
  return `
$ErrorActionPreference='Stop'
$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${helperPid}'
if($null -eq $p -or $p.Name -ne 'powershell.exe' -or $p.ParentProcessId -ne ${ownerPid}){exit 30}
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Drawing; using System.Drawing.Imaging;
public static class AkcMetadataDriver {
 delegate bool EnumProc(IntPtr w,IntPtr d);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr p,IntPtr a,string c,string t);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr w,out uint p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr w,EnumProc f,IntPtr d);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr w,StringBuilder b,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr w,StringBuilder b,int n);
 [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr w,uint m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr w,uint m,IntPtr a,IntPtr b);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr w);
 [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr w);
 [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr w,int n);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr w,out RECT r);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [StructLayout(LayoutKind.Sequential)] struct RECT {public int L,T,R,B;}
 public static IntPtr Find(string caption,uint pid){IntPtr w=IntPtr.Zero;for(int i=0;i<256;i++){w=FindWindowExW(IntPtr.Zero,w,null,caption);if(w==IntPtr.Zero)break;uint p;GetWindowThreadProcessId(w,out p);if(p==pid)return w;}return IntPtr.Zero;}
 public static void Operate(IntPtr w,int index,bool cancel,string image){
   var controls=new List<IntPtr>();EnumChildWindows(w,(c,d)=>{controls.Add(c);return true;},IntPtr.Zero);
   IntPtr choice=IntPtr.Zero,button=IntPtr.Zero;
   foreach(var c in controls){var b=new StringBuilder(256);GetClassNameW(c,b,256);string cls=b.ToString().ToUpperInvariant();
     if(cls.Contains("EDIT")&&(GetWindowLongW(c,-16)&32)!=0)throw new Exception("Password control forbidden");
     if(cls.Contains("COMBOBOX"))choice=c;
     if(cls.Contains("BUTTON")){b.Clear();GetWindowTextW(c,b,256);string t=b.ToString();if(cancel?(t=="Cancel"||t=="キャンセル"||t=="キャンセル / Cancel"):(t=="Associate"||t=="関連付ける"||t=="変更を確定 / Confirm"||t=="登録する / Register"))button=c;}
   }
   if(index>=0&&!cancel){if(choice==IntPtr.Zero)throw new Exception("No selection");if(SendMessageW(choice,0x14E,(IntPtr)index,IntPtr.Zero).ToInt64()!=index)throw new Exception("Selection failed");SendMessageW(GetParent(choice),0x111,(IntPtr)(GetDlgCtrlID(choice)|(1<<16)),choice);}
   System.Threading.Thread.Sleep(250);if(button==IntPtr.Zero||!IsWindowVisible(button))throw new Exception("No button");if(image!=null&&!Save(w,image))throw new Exception("Capture failed");PostMessageW(button,0xF5,IntPtr.Zero,IntPtr.Zero);
 }
 public static bool Save(IntPtr w,string path){SetThreadDpiAwarenessContext((IntPtr)(-4));RECT r;if(!GetWindowRect(w,out r))return false;using(var b=new Bitmap(r.R-r.L,r.B-r.T)){using(var g=Graphics.FromImage(b)){var dc=g.GetHdc();bool ok;try{ok=PrintWindow(w,dc,0);}finally{g.ReleaseHdc(dc);}if(!ok)return false;}b.Save(path,ImageFormat.Png);}return true;}
}
'@ -ReferencedAssemblies System.Drawing
$deadline=[DateTime]::UtcNow.AddSeconds(35); $w=[IntPtr]::Zero
do {$w=[AkcMetadataDriver]::Find(${ps(caption)},${helperPid});if($w -ne [IntPtr]::Zero){break};Start-Sleep -Milliseconds 150}while([DateTime]::UtcNow -lt $deadline)
if($w -eq [IntPtr]::Zero){exit 31}
Start-Sleep -Milliseconds 300
[AkcMetadataDriver]::Operate($w,${index ?? -1},$${cancel ? "true" : "false"},${imagePath ? ps(imagePath) : "$null"})
exit 0
`;
}
