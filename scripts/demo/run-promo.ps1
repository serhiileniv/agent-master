# Records the Agent Master promo end to end.
#
#   1. reseed the throwaway demo repos
#   2. launch the choreographer detached (WMI escapes the tool session's job
#      object, so the window actually appears and survives)
#   3. wait for its `ready` signal, start ffmpeg (gdigrab full desktop)
#   4. write `go` so the timeline plays into the recording
#   5. on `done`, trim the raw capture to the exact timeline length
#
# Output: %TEMP%\agentmaster-demo\out\agentmaster-promo.mp4
$ErrorActionPreference = 'Stop'

$repo   = 'D:\IT\Projects\agent-canvas'
$demo   = Join-Path $env:TEMP 'agentmaster-demo'
$signal = Join-Path $demo 'signal'
$outDir = Join-Path $demo 'out'
$ff     = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'
$exe    = Join-Path $repo 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path $ff))  { throw "ffmpeg not found at $ff" }
if (-not (Test-Path $exe)) { throw "electron not found at $exe" }

Write-Host '[run] reseeding demo repos'
Push-Location $repo
& node scripts\demo\seed-demo.cjs --clean | Out-Null
Pop-Location

# AFTER the reseed -- `--clean` removes the whole demo root, which would take the
# output directory with it and leave ffmpeg with nowhere to write.
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

if (Test-Path $signal) { Remove-Item "$signal\*" -Force -ErrorAction SilentlyContinue }

# Plain Start-Process, NOT WMI. This script must be run by the user in their own
# terminal: a process launched from an agent tool session lands on a different
# window station, so its window never appears on the real desktop and there is
# nothing for the recorder to capture.
Write-Host '[run] launching choreographer'
Start-Process -FilePath $exe -WorkingDirectory $repo `
  -ArgumentList (Join-Path $repo 'scripts\demo\promo.cjs')

Write-Host '[run] waiting for ready'
$deadline = (Get-Date).AddSeconds(120)
while (-not (Test-Path (Join-Path $signal 'ready'))) {
  if ((Get-Date) -gt $deadline) { throw 'timed out waiting for ready' }
  Start-Sleep -Milliseconds 300
}

$raw   = Join-Path $outDir 'raw.mp4'
$final = Join-Path $outDir 'agentmaster-promo.mp4'
Write-Host '[run] starting ffmpeg'
# -draw_mouse 0: a stray cursor parked mid-canvas reads as a dead pixel in a promo.
# PRIVACY GATE. gdigrab's title= capture returns black for Chromium's
# GPU-composited windows, so we must grab the desktop -- which means we must be
# certain the fullscreen app is frontmost first. If it is not, abort WITHOUT
# recording rather than filming whatever the user has open.
# Windows' foreground lock stops a detached process from stealing focus, but
# alwaysOnTop still draws the window over everything -- and visual coverage, not
# focus, is what the capture actually sees. So probe which window is VISIBLE at
# several screen points; every one must be ours before a frame is recorded.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public class ZProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string At(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    IntPtr h = GetAncestor(WindowFromPoint(p), 2 /* GA_ROOT */);
    var sb = new StringBuilder(512);
    GetWindowText(h, sb, 512);
    return sb.ToString();
  }
}
'@
# The user's real Agent Master may legitimately be running (this session can be hosted
# inside it), and the two windows are visually identical -- so raise the demo
# window by its unique caption rather than asking anyone to pick the right one.
# Called from the user's interactive session, so the foreground change is allowed.
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public class WRaise {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after,
    int x, int y, int cx, int cy, uint flags);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static bool Raise(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return false;
    ShowWindow(found, 9);                                    // SW_RESTORE
    SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, 0x0003); // HWND_TOPMOST | NOSIZE|NOMOVE
    BringWindowToTop(found);
    SetForegroundWindow(found);
    return true;
  }
}
'@

$probes = @(@(960, 540), @(120, 140), @(1800, 900), @(960, 1000))
$bad = $null
for ($i = 0; $i -lt 75; $i++) {
  $null = [WRaise]::Raise('AgentMasterPromoCapture')
  Start-Sleep -Milliseconds 250
  $bad = $null
  foreach ($p in $probes) {
    $t = [ZProbe]::At($p[0], $p[1])
    if ($t -ne 'AgentMasterPromoCapture') { $bad = "$t @ $($p[0]),$($p[1])"; break }
  }
  if (-not $bad) { break }
  # Windows can refuse the topmost promotion if another window was just focused.
  # Give the user a chance to click Agent Master rather than failing after 10s.
  if ($i -eq 8) {
    Write-Host "[run] Still not in front (seeing '$bad') - retrying the raise."
    Write-Host '[run] The demo window is the FULLSCREEN one (tabs: storefront / payments-api / mobile-app).'
    Write-Host '[run] Click it if this does not clear on its own. Waiting up to 30s...'
  }
  Start-Sleep -Milliseconds 400
}
if ($bad) {
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force
  throw "ABORTED: the Agent Master window is not covering the screen (saw '$bad'). Nothing was recorded."
}
Write-Host '[run] screen coverage verified: AgentMasterPromoCapture'

Start-Process -FilePath $ff -WindowStyle Hidden -ArgumentList @(
  '-y', '-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-i', 'desktop',
  '-t', '80', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart', $raw
)
Start-Sleep -Milliseconds 1200   # let the encoder spin up before the first beat

Write-Host '[run] go'
New-Item -ItemType File -Path (Join-Path $signal 'go') -Force | Out-Null

$deadline = (Get-Date).AddSeconds(180)
while (-not (Test-Path (Join-Path $signal 'done'))) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Milliseconds 300
}
$elapsed = (Get-Content (Join-Path $signal 'done') -Raw).Trim()
Write-Host "[run] timeline done: $elapsed s"

Write-Host '[run] waiting for ffmpeg to finish'
try { Wait-Process -Name ffmpeg -Timeout 120 } catch { }

# Trim the raw capture to the timeline. 1.2s of encoder warm-up sits at the head.
$dur = 0.0
[double]::TryParse($elapsed, [ref]$dur) | Out-Null
if ($dur -le 0) { $dur = 50 }
Write-Host "[run] trimming to $dur s"
# No 2>&1 here: redirecting a native exe's stderr in PS 5.1 wraps each line in an
# ErrorRecord and fails the script even on exit code 0.
& $ff -y -ss 1.2 -i $raw -t $dur -c copy $final -loglevel error

Get-Item $final | ForEach-Object { "[run] OUTPUT: $($_.FullName)  $([math]::Round($_.Length/1MB,1)) MB" }
