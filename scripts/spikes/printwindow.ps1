# Spike: can PrintWindow capture a window that is NOT in the foreground (covered
# by other windows) without foregrounding it, and does it work for Chromium and
# Electron windows? Also prints DPI info (is this process DPI aware?).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/spikes/printwindow.ps1 [-Names chrome,Cursor,notepad]
#
# Results are recorded in docs/CHROME_SPIKES.md.
param([string[]]$Names = @("chrome", "Cursor", "Code", "notepad", "Discord", "explorer"))

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] public static extern int GetAwarenessFromDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$fg = [W]::GetForegroundWindow()
"foreground hwnd: $fg; this process DPI awareness: $([W]::GetAwarenessFromDpiAwarenessContext([W]::GetThreadDpiAwarenessContext())) (0=unaware,1=system,2=per-monitor)"

$rows = New-Object System.Collections.ArrayList
$cb = [W+EnumProc]{
  param($h, $l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetWindowText($h, $sb, 256)
  if ($sb.Length -eq 0) { return $true }
  [uint32]$procId = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$procId)
  $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -eq $p) { return $true }
  [void]$rows.Add([pscustomobject]@{ H = $h; Title = $sb.ToString(); Proc = $p.ProcessName })
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)

function Probe($h, $flags) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -le 0 -or $ht -le 0) { return "empty rect" }
  $bmp = New-Object System.Drawing.Bitmap $w, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [W]::PrintWindow($h, $hdc, $flags)
  $g.ReleaseHdc($hdc); $g.Dispose()
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $rnd = New-Object System.Random 7
  for ($i = 0; $i -lt 3000; $i++) { [void]$seen.Add($bmp.GetPixel($rnd.Next($w), $rnd.Next($ht)).ToArgb()) }
  $bmp.Dispose()
  "ok=$ok size=${w}x${ht} distinctColorsIn3000=$($seen.Count)"
}

foreach ($n in $Names) {
  foreach ($row in ($rows | Where-Object { $_.Proc -ieq $n } | Select-Object -First 2)) {
    $dpi = [W]::GetDpiForWindow($row.H)
    $min = [W]::IsIconic($row.H)
    $isFg = ($row.H -eq $fg)
    "[$($row.Proc)] hwnd=$($row.H) fg=$isFg minimized=$min dpi=$dpi title='$($row.Title.Substring(0, [Math]::Min(50, $row.Title.Length)))'"
    "   PrintWindow flags=0: $(Probe $row.H 0)"
    "   PrintWindow flags=2 (PW_RENDERFULLCONTENT): $(Probe $row.H 2)"
  }
}
