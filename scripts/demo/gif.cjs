// README GIF capture.
//
// Same harness as promo.cjs (real renderer + real IPC), but instead of running
// the full ~51s timeline it plays a short loop-friendly choreography and grabs
// frames with capturePage(). Video capture proper needs an external recorder and
// a visible window; capturePage works headlessly, which is what makes this
// runnable from an agent session.
//
//   node_modules/electron/dist/electron.exe scripts/demo/gif.cjs
//   -> <demo>/frames/f%05d.png  + a measured FPS written to frames/fps.txt
//
// Encode with scripts/demo/make-gif.ps1 (palettegen/paletteuse).
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const { join } = require('path')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const DEMO_ROOT = join(os.tmpdir(), 'agentmaster-demo')
const FRAMES = join(DEMO_ROOT, 'frames')
const NAMES = ['storefront', 'payments-api', 'mobile-app']
const PATHS = NAMES.map((n) => join(DEMO_ROOT, n))

// 1600x900 is the knee of the capture curve (see bench-capture.cjs): 13.3fps at
// 1280x720, 11.2fps here for 56% more pixels, then a cliff to 6.9fps at 1080p.
// Capturing above the display size and downscaling in ffmpeg is what keeps the
// terminal text sharp in the final GIF.
const W = 1600
const H = 900

const t0 = Date.now()
const log = (m) => console.log(`[gif ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Reuse the promo's transcript vocabulary, trimmed: the GIF only needs each pane
// to look busy and plausible for ~9 seconds, so one short phase per agent is
// enough and keeps every pane on its first (never-cleared) cycle for the whole
// capture -- no blanking mid-loop.
const decl = '$D=[char]0x25CF; $E=[char]0x23BF'
function work(seq, speed) {
  const body = seq
    .map(
      ([text, colour, ms]) =>
        `Write-Host "${text}" -ForegroundColor ${colour}; Start-Sleep -Milliseconds ${Math.round(ms * speed)}`
    )
    .join('; ')
  return `Clear-Host; ${decl}; ${body}; while ($true) { Start-Sleep -Seconds 5 }`
}
const call = (t, ms = 620) => [`$D ${t}`, 'White', ms]
const res = (t, ms = 480) => [`  $E  ${t}`, 'DarkGray', ms]
const plus = (n, t, ms = 300) => [`     ${n} +  ${t}`, 'Green', ms]
const ok = (t, ms = 520) => [`  $E  ${t}`, 'Green', ms]
const say = (t, ms = 780) => [`$D ${t}`, 'White', ms]
const gap = (ms = 300) => ['', 'DarkGray', ms]

const AGENTS = [
  {
    agentId: 'claude',
    agentLabel: 'Claude Code',
    speed: 1.0,
    seq: [
      say('I will add discount support to the cart total.'),
      gap(),
      call('Read(src/cart.ts)'),
      res('Read 14 lines'),
      gap(),
      call('Update(src/cart.ts)'),
      res('Updated src/cart.ts with 4 additions'),
      plus(11, 'export function applyDiscount(): void {'),
      plus(12, '  // implemented by agent'),
      gap(),
      call('Bash(npm test -- cart)'),
      ok('PASS  src/cart.test.ts'),
      say('applyDiscount() is ready for review.')
    ]
  },
  {
    agentId: 'codex',
    agentLabel: 'Codex',
    speed: 1.12,
    seq: [
      say('Adding address validation to the checkout flow.'),
      gap(),
      call('Read(src/checkout.ts)'),
      res('Read 22 lines'),
      gap(),
      call('Update(src/checkout.ts)'),
      res('Updated with 18 additions'),
      plus(31, 'if (!addr) throw new Error(address required)'),
      gap(),
      call('Bash(npm run lint)'),
      ok('0 problems'),
      say('Address validation is in place.')
    ]
  },
  {
    agentId: 'gemini',
    agentLabel: 'Gemini',
    speed: 0.9,
    seq: [
      say('Enabling route prefetching on hover.'),
      gap(),
      call('Read(src/router.ts)'),
      res('Read 19 lines'),
      gap(),
      call('Update(src/router.ts)'),
      res('Updated with 9 additions'),
      plus(22, 'links.forEach(l => l.on(mouseenter, warm))'),
      gap(),
      call('Bash(npm run build)'),
      ok('bundle 214 kB  (-8 kB)'),
      say('Route prefetching enabled.')
    ]
  },
  {
    agentId: 'claude',
    agentLabel: 'Claude Code',
    speed: 1.2,
    seq: [
      say('Registering a service worker for offline cache.'),
      gap(),
      call('Read(src/index.ts)'),
      res('Read 11 lines'),
      gap(),
      call('Update(src/index.ts)'),
      res('Updated with 4 additions'),
      plus(7, 'navigator.serviceWorker.register(/sw.js)'),
      gap(),
      call('Bash(npm run build)'),
      ok('built in 2.1s'),
      say('Offline cache verified.')
    ]
  },
  {
    agentId: 'codex',
    agentLabel: 'Codex',
    speed: 0.84,
    seq: [
      say('Adding dark-mode design tokens.'),
      gap(),
      call('Read(src/styles.css)'),
      res('Read 6 lines'),
      gap(),
      call('Update(src/styles.css)'),
      res('Updated with 12 additions'),
      plus(4, '--bg-elev: #16161a;'),
      plus(5, '--text-dim: #8b8b93;'),
      gap(),
      call('Bash(npx stylelint src)'),
      ok('0 problems'),
      say('Dark-mode tokens landed.')
    ]
  },
  {
    agentId: 'gemini',
    agentLabel: 'Gemini',
    speed: 1.06,
    seq: [
      say('Profiling cart totals for hot paths.'),
      gap(),
      call('Read(src/cart.ts)'),
      res('Read 14 lines'),
      gap(),
      call('Update(src/cart.ts)'),
      res('Updated with 6 additions'),
      plus(19, 'const cache = new Map()'),
      gap(),
      call('Bash(npm run bench)'),
      ok('total()   1.8ms -> 0.3ms'),
      say('Benchmarks re-run and green.')
    ]
  }
]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  fs.rmSync(FRAMES, { recursive: true, force: true })
  fs.mkdirSync(FRAMES, { recursive: true })

  const win = new BrowserWindow({
    width: W,
    height: H,
    x: 0,
    y: 0,
    show: true,
    title: 'AgentMasterGifCapture',
    backgroundColor: '#00000000',
    backgroundMaterial: 'mica',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e6e9f0', height: 40 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '..', '..', 'out', 'preload', 'index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  registerIpc(() => win)

  const js = async (code) => {
    const wrapped = `(async () => { try { return { ok: true, v: await (${code}) } } catch (e) { return { ok: false, error: String((e && e.stack) || e) } } })()`
    let r
    try {
      r = await win.webContents.executeJavaScript(wrapped, true)
    } catch (e) {
      log('!! executeJavaScript failed: ' + e.message)
      return null
    }
    if (!r || !r.ok) {
      log('!! renderer error: ' + (r ? r.error : 'no result'))
      return null
    }
    return r.v
  }

  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  await js(`(() => {
    localStorage.setItem('vectro.openWorkspaces', ${JSON.stringify(JSON.stringify({ paths: PATHS, active: PATHS[0] }))});
    localStorage.setItem('vectro.recent', ${JSON.stringify(JSON.stringify(PATHS.map((p, i) => ({ path: p, name: NAMES[i] }))))});
    return true
  })()`)
  win.reload()
  await new Promise((r) => win.webContents.once('did-finish-load', r))

  await js(`(() => {
    window.__demo = {
      S() { return window.__agentStore.getState() },
      AW() { const s = this.S(); return s.liveWorkspaces.find(w => w.id === s.activeWorkspaceId) },
      wsPath(w) { return w.defaultPath != null ? w.defaultPath : w.path },
      ids() { const w = this.AW(); return w ? w.agents.map(a => a.id) : [] }
    };
    return true
  })()`)
  for (let i = 0; i < 60; i++) {
    if ((await js(`window.__demo.S().liveWorkspaces.length`)) >= 1) break
    await sleep(400)
  }

  // Smaller window than the promo -> smaller panes, so drop the font a notch;
  // 16 at 1280x720 would wrap the longer transcript lines.
  await js(`(() => {
    const set = window.__demo.S().setSetting;
    set('theme', 'dark'); set('fontSize', 15);
    set('fontFamily', 'Cascadia Code, Consolas, monospace');
    set('terminalOpacity', 0.62); set('wallpaper', null); set('accent', '#ff453a');
    window.__agentStore.setState(s => ({ settings: { ...s.settings, defaultIsolation: 'worktree', defaultShellId: 'powershell' } }));
    return true
  })()`)

  // Activate storefront and clear the auto-created agent.
  const wsId = await js(
    `(() => { const w = window.__demo.S().liveWorkspaces.find(w => window.__demo.wsPath(w) === ${JSON.stringify(PATHS[0])}); return w ? w.id : null })()`
  )
  if (wsId) await js(`(() => { window.__demo.S().setActiveWorkspace(${JSON.stringify(wsId)}); return true })()`)
  await sleep(600)
  await js(`(() => {
    const w = window.__demo.AW();
    w.agents.map(a => a.id).forEach(id => window.__demo.S().removeAgent(id, { keepWorktree: false }));
    return true
  })()`)
  await sleep(1200)
  await js(`(() => { window.dispatchEvent(new Event('resize')); window.__demo.S().relayout(); return true })()`)
  await sleep(800)
  log('staged — starting capture')

  // ---- Capture loop -------------------------------------------------------
  // Self-correcting interval: capturePage takes 60-150ms at this size, so a
  // naive setInterval would drift and the GIF would play back at the wrong
  // speed. Measure the real elapsed time and hand ffmpeg the achieved FPS.
  const TARGET_FPS = 12
  const STEP = 1000 / TARGET_FPS
  const DURATION = 9500
  let n = 0
  let stop = false
  const started = Date.now()
  // Per-frame wall clock. capturePage is not uniform (an empty canvas encodes far
  // faster than six live panes), so encoding at one average fps makes the opening
  // play fast and the busy end play slow. Same trap as the video path.
  const times = []

  // Choreography runs concurrently with the capture: agents land one by one so
  // the GIF opens on the tiling animation, which is the single most legible
  // "this app runs many agents" moment.
  const choreo = (async () => {
    for (const a of AGENTS) {
      await js(
        `(() => { window.__demo.S().addAgent(${JSON.stringify({
          command: work(a.seq, a.speed),
          agentId: a.agentId,
          agentLabel: a.agentLabel,
          shellId: 'powershell'
        })}); return true })()`
      )
      await sleep(430)
    }
  })()

  while (!stop) {
    const due = started + n * STEP
    const wait = due - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      const img = await win.webContents.capturePage()
      // toJPEG, not toPNG: PNG encoding a 1280x720 frame costs ~280ms and caps
      // the capture at ~3.5fps, which reads as a slideshow. JPEG encodes several
      // times faster and the difference is invisible once GIF quantises the
      // result down to 256 colours.
      const buf = img.toJPEG(92)
      // A zero-byte first frame (window not yet painted) makes ffmpeg's concat
      // demuxer fail outright — skip rather than write it.
      if (buf.length > 0) {
        fs.writeFileSync(join(FRAMES, `f${String(n).padStart(5, '0')}.jpg`), buf)
        times.push(Date.now())
        n++
      }
    } catch (e) {
      log('capture failed at frame ' + n + ': ' + e.message)
    }
    if (Date.now() - started >= DURATION) stop = true
  }
  await choreo

  const elapsed = (Date.now() - started) / 1000
  const fps = n / elapsed
  fs.writeFileSync(join(FRAMES, 'fps.txt'), fps.toFixed(3))
  // concat demuxer list with real per-frame durations — the only way the GIF
  // plays at true speed given the uneven capture rate.
  const lines = []
  for (let i = 0; i < n; i++) {
    const dur = ((i + 1 < n ? times[i + 1] : Date.now()) - times[i]) / 1000
    lines.push(`file 'f${String(i).padStart(5, '0')}.jpg'`)
    lines.push(`duration ${Math.max(0.008, dur).toFixed(4)}`)
  }
  lines.push(`file 'f${String(n - 1).padStart(5, '0')}.jpg'`)
  fs.writeFileSync(join(FRAMES, 'concat.txt'), lines.join('\n') + '\n')
  const spread = times.slice(1).map((t, i) => t - times[i])
  log(
    `captured ${n} frames in ${elapsed.toFixed(1)}s -> ${fps.toFixed(2)} fps avg ` +
      `(gap min ${Math.min(...spread)}ms / max ${Math.max(...spread)}ms)`
  )
  log('frames: ' + FRAMES)
  app.exit(0)
})

setTimeout(() => {
  log('TIMEOUT')
  app.exit(3)
}, 180000)
