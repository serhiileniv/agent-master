# Encodes the README GIF from the frames captured by gif.cjs.
#
#   node_modules\electron\dist\electron.exe scripts\demo\gif.cjs
#   powershell -File scripts\demo\make-gif.ps1
#
# Output: assets\demo.gif
$ErrorActionPreference = 'Stop'

$repo   = 'D:\IT\Projects\agent-canvas'
$demo   = Join-Path $env:TEMP 'spymaster-demo'
$frames = Join-Path $demo 'frames'
$out    = Join-Path $repo 'assets\demo.gif'
$ff     = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe'

if (-not (Test-Path $ff))     { throw "ffmpeg not found at $ff" }
if (-not (Test-Path $frames)) { throw "no frames at $frames - run gif.cjs first" }

# gif.cjs writes concat.txt with a REAL per-frame duration. capturePage is not
# uniform (an empty canvas encodes far faster than six live panes), so encoding at
# a single average fps makes the opening play fast and the busy end play slow.
$concat = Join-Path $frames 'concat.txt'
if (-not (Test-Path $concat)) { throw "no concat.txt - re-run gif.cjs" }

# Frames are captured at 1600x900 and downscaled here: sampling above the display
# size is what keeps terminal text sharp. 1120px / 40 colours / 7fps is the knee
# for this UI -- 1040px at 48 colours and 8fps costs another 0.9 MB for no visible
# gain, and dropping below 40 colours bands the gradient. The two-stage palette
# (generate, then apply) is mandatory; ffmpeg's default quantiser wrecks darks.
Push-Location $frames
& $ff -y -f concat -safe 0 -i concat.txt `
  -vf "fps=7,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=40:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" `
  -loop 0 $out -loglevel error
Pop-Location

$mb = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "[gif] OUTPUT: $out  $mb MB"
if ($mb -gt 3) { Write-Host "[gif] WARNING: over 3 MB - drop fps or width" }
