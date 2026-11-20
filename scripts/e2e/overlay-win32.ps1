# Read-only Win32 probe for the overlay end-to-end harness. For each window handle it reports the extended style,
# display affinity (screen-capture exclusion), title, visibility and rectangle; for each point it reports which
# top-level window the system hit-tests there. It never moves the pointer or changes any window.
param([Parameter(Mandatory = $true)][string]$InputFile)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class OverlayWin32 {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
}
"@

[void][OverlayWin32]::SetProcessDPIAware()
$probe = Get-Content -Raw -LiteralPath $InputFile | ConvertFrom-Json
$GA_ROOT = 2

$windows = @()
foreach ($w in $probe.windows) {
  $h = [IntPtr][long]$w.hwnd
  $affinity = [uint32]0
  [void][OverlayWin32]::GetWindowDisplayAffinity($h, [ref]$affinity)
  $rect = New-Object OverlayWin32+RECT
  [void][OverlayWin32]::GetWindowRect($h, [ref]$rect)
  $title = New-Object System.Text.StringBuilder 256
  [void][OverlayWin32]::GetWindowText($h, $title, 256)
  $windows += [pscustomobject]@{
    name     = $w.name
    ex       = [int64][OverlayWin32]::GetWindowLongPtr($h, -20)
    affinity = [int64]$affinity
    title    = $title.ToString()
    visible  = [OverlayWin32]::IsWindowVisible($h)
    left     = $rect.Left
    top      = $rect.Top
    right    = $rect.Right
    bottom   = $rect.Bottom
  }
}

$points = @()
foreach ($p in $probe.points) {
  $pt = New-Object OverlayWin32+POINT
  $pt.X = [int]$p.x
  $pt.Y = [int]$p.y
  $hit = [OverlayWin32]::WindowFromPoint($pt)
  $root = if ($hit -eq [IntPtr]::Zero) { [IntPtr]::Zero } else { [OverlayWin32]::GetAncestor($hit, $GA_ROOT) }
  $points += [pscustomobject]@{ name = $p.name; hit = [int64]$hit; root = [int64]$root }
}

[pscustomobject]@{ windows = $windows; points = $points } | ConvertTo-Json -Depth 5 -Compress
