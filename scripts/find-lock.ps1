Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Rm {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmStartSession(out uint h, int f, string k);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern int RmRegisterResources(uint h, uint nf, string[] files, uint na, [In] RM_UP[] apps, uint ns, string[] svc);
  [DllImport("rstrtmgr.dll")]
  public static extern int RmGetList(uint h, out uint need, ref uint n, [In, Out] RM_PI[] arr, ref uint r);
  [StructLayout(LayoutKind.Sequential)]
  public struct RM_UP { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME t; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct RM_PI {
    public RM_UP P;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string App;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Svc;
    public int AppType; public uint Status; public uint Sid;
    [MarshalAs(UnmanagedType.Bool)] public bool Rest;
  }
}
'@

function Find-Locker($p) {
  $h = 0
  [void][Rm]::RmStartSession([ref]$h, 0, [guid]::NewGuid().ToString())
  [void][Rm]::RmRegisterResources($h, 1, @($p), 0, $null, 0, $null)
  $n = [uint32]0; $need = [uint32]0; $r = [uint32]0
  $a = New-Object 'Rm+RM_PI[]' 0
  $ret = [Rm]::RmGetList($h, [ref]$need, [ref]$n, $a, [ref]$r)
  if ($ret -eq 234) {
    $a = New-Object 'Rm+RM_PI[]' $need; $n = $need
    [void][Rm]::RmGetList($h, [ref]$need, [ref]$n, $a, [ref]$r)
  }
  [void][Rm]::RmEndSession($h)
  Write-Host "FILE: $p  => $need locker(s)"
  if ($need -gt 0) { $a | ForEach-Object {
    $pr = Get-Process -Id $_.P.pid -ErrorAction SilentlyContinue
    "  PID=$($_.P.pid)  App=$($_.App)  Proc=$($pr.ProcessName)"
  } }
}

Find-Locker 'C:\UGit\nowen-note\dist-electron\win-unpacked\Nowen Note.exe'
Find-Locker 'C:\UGit\nowen-note\release\win-unpacked\resources\app.asar'
