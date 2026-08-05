// Spy Master promo choreographer.
//
// Runs the REAL app (real renderer + real main-process IPC, so worktrees, PTYs,
// diffs and merges are genuine) in a fullscreen window, then drives it through a
// ~55s scripted demo while an external recorder captures the desktop.
//
// The agents are real terminal cards doing real git-worktree isolation; only the
// *work they print* is scripted, so no Claude sessions and no API cost are needed.
// Spy Master derives a card's working/idle/done state purely from terminal output, so
// a looping shell command produces the authentic animations.
//
// Handshake with the recorder (files under <demo>/signal):
//   promo writes `ready`  -> orchestrator starts ffmpeg
//   orchestrator writes `go` -> promo runs the timeline
//   promo writes `done`   -> orchestrator stops ffmpeg
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const os = require('os')
const { join } = require('path')
const { registerIpc } = require(join(__dirname, '..', '..', 'out', 'main', 'ipc.js'))

const DEMO_ROOT = join(os.tmpdir(), 'spymaster-demo')
const SIGNAL = join(DEMO_ROOT, 'signal')
const NAMES = ['storefront', 'payments-api', 'mobile-app']
const PATHS = NAMES.map((n) => join(DEMO_ROOT, n))
const SOLO = process.argv.includes('--solo') // run timeline immediately, no recorder
// --capture: grab frames straight off the window with capturePage() and encode
// them to mp4 afterwards, instead of screen-recording the desktop with gdigrab.
// Two advantages: it runs headlessly (no window-station / foreground dance, so an
// agent session can produce the video unattended) and it can only ever contain
// this window -- the desktop is never in frame, so the privacy gate is moot.
// The cost is frame rate: capturePage + JPEG encode tops out around 12fps.
const CAPTURE = process.argv.includes('--capture')
const VFRAMES = join(DEMO_ROOT, 'vframes')
// Capture cost scales with pixel count (the JPEG encode dominates), so capture
// resolution trades directly against frame rate. --size=WxH to measure the knee.
const SIZE_ARG = (process.argv.find((a) => a.startsWith('--size=')) || '').split('=')[1]
const [SZ_W, SZ_H] = SIZE_ARG ? SIZE_ARG.split('x').map(Number) : [1280, 720]
const WIN_W = CAPTURE ? SZ_W : 1920
const WIN_H = CAPTURE ? SZ_H : 1080
// Font has to scale with the window or the panes wrap: 13 suits 720p, 16 suits
// 1080p (the same value the fullscreen recorder path uses).
const CAP_FONT = SZ_H >= 1000 ? 16 : SZ_H >= 860 ? 15 : 13
/** Must match the -i title=... passed to ffmpeg in run-promo.ps1. */
const CAPTURE_TITLE = 'SpyMasterPromoCapture'

const t0 = Date.now()
const LOG_FILE = join(DEMO_ROOT, 'promo.log')
// Also to a file: when the user runs this themselves the console output goes to
// their terminal, leaving no record to diagnose a bad take from.
const log = (m) => {
  const line = `[promo ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`
  console.log(line)
  try {
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch {
    /* ignore */
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Fake-but-real agent work: prints progress, then makes a genuine file edit in
 *  the agent's own worktree (so the diff/merge beat has real content), then idles
 *  noisily enough to keep the card green. Single quotes only -- this string is
 *  typed into a PowerShell prompt. */
/** Builds an agent's terminal script from a [text, colour, pauseMs] sequence.
 *
 *  Two things matter here:
 *  - The real file edit lands FIRST and only once, so the worktree diff is
 *    populated within a second of the shell starting (the diff/merge beat is
 *    ~37s in and must never race the animation) and stays a tidy +4.
 *  - The sequence then LOOPS forever. A card that falls quiet looks dead, and
 *    maximising a pane remounts its xterm and drops the scrollback -- dense,
 *    continuous output means any card refills within a couple of seconds.
 *
 *  Single quotes only: this whole string gets typed into a PowerShell prompt. */
/** `speed` scales every pause in the sequence. Agents are spawned within ~2s of
 *  each other and their sequences are the same length, so at speed 1 all six
 *  clear IN UNISON -- the whole canvas periodically blanks at once, and any beat
 *  landing near that moment films six near-empty panes. Giving each agent a
 *  slightly different tempo makes the cycles drift apart and stay apart, so at
 *  most one pane is refilling at any given time. */
function work(seq, file, symbol, speed = 1) {
  // Build the bullet/elbow glyphs at RUNTIME from code points. Typing them into
  // the PTY as literal UTF-8 risks mangling; [char] is encoding-proof.
  const decl = '$D=[char]0x25CF; $E=[char]0x23BF'
  const edit = `Add-Content -Path '${file}' -Value @('', 'export function ${symbol}(): void {', '  // implemented by agent', '}')`
  // Double-quoted so $D/$E interpolate. Sequence text must contain no other '$'.
  const body = seq
    .map(
      ([text, colour, ms]) =>
        `Write-Host "${text}" -ForegroundColor ${colour}; Start-Sleep -Milliseconds ${Math.round(ms * speed)}`
    )
    .join('; ')
  // Clear INSIDE the loop, not just once before it. A short sequence in a tall
  // pane otherwise stacks identical transcripts on top of each other -- four
  // copies of "Hardening webhook signature checks" in one viewport reads as
  // obviously canned. Clearing makes each cycle read as the agent picking up a
  // fresh task, which is what a real session looks like.
  // A longer pause between cycles so a repeat reads as the agent picking up new
  // work rather than the same transcript restarting mid-sentence.
  return `${decl}; ${edit}; while ($true) { Clear-Host; ${body}; Start-Sleep -Milliseconds ${Math.round(3000 * speed)} }`
}

/** Shorthand for the three line shapes a session is made of. */
const call = (t, ms = 700) => [`$D ${t}`, 'White', ms]
const res = (t, ms = 550) => [`  $E  ${t}`, 'DarkGray', ms]
// Named plus/minus, not add/del -- `add` is already the agent-spawning helper.
const plus = (n, t, ms = 320) => [`     ${n} +  ${t}`, 'Green', ms]
const minus = (n, t, ms = 320) => [`     ${n} -  ${t}`, 'Red', ms]
const ok = (t, ms = 600) => [`  $E  ${t}`, 'Green', ms]
/** Continuation of the previous result -- indented, no second elbow glyph. */
const cont = (t, ms = 550) => [`     ${t}`, 'DarkGray', ms]
const say = (t, ms = 900) => [`$D ${t}`, 'White', ms]
const gap = (ms = 350) => ['', 'DarkGray', ms]

/** The six agents on the hero canvas (storefront). Each reads like a real
 *  coding-agent session: tool call, result, test run, verdict. */
const HERO = [
  {
    agentId: 'claude',
    agentLabel: 'Claude Code',
    cmd: work(
      [
        say('I will add discount support to the cart total.', 800),
        gap(),
        call('Read(src/cart.ts)'),
        res('Read 14 lines'),
        gap(),
        call('Update(src/cart.ts)', 800),
        res('Updated src/cart.ts with 4 additions'),
        plus(11, 'export function applyDiscount(): void {'),
        plus(12, '  // implemented by agent'),
        plus(13, '}'),
        gap(),
        call('Bash(npm test -- cart)', 950),
        ok('PASS  src/cart.test.ts'),
        cont('Tests: 12 passed, 12 total', 700),
        gap(),
        say('applyDiscount() is ready for review.', 1100),
        gap(600),
        say('Now covering the discount path with tests.', 800),
        gap(),
        call('Update(src/cart.test.ts)', 800),
        res('Added 3 test cases'),
        plus(41, 'expect(applyDiscount(100)).toBe(90)'),
        gap(),
        call('Bash(npm test -- cart)', 950),
        ok('PASS  src/cart.test.ts'),
        cont('Tests: 15 passed, 15 total', 700),
        gap(),
        say('Discount path fully covered.', 1100)
      ],
      'src/cart.ts',
      'applyDiscount',
      1.0
    )
  },
  {
    agentId: 'codex',
    agentLabel: 'Codex',
    cmd: work(
      [
        say('Adding address validation to the checkout flow.', 800),
        gap(),
        call('Read(src/checkout.ts)'),
        res('Read 22 lines'),
        gap(),
        call('Update(src/checkout.ts)', 800),
        res('Updated src/checkout.ts with 18 additions and 2 removals'),
        minus(31, 'if (!addr) return'),
        plus(31, 'if (!addr) throw new Error(address required)'),
        plus(32, 'if (!addr.postcode) return invalid(postcode)'),
        gap(),
        call('Bash(npm run lint)', 900),
        ok('0 problems'),
        gap(),
        call('Bash(npm test -- checkout)', 850),
        ok('PASS  src/checkout.test.ts'),
        gap(),
        say('Address validation is in place.', 1100),
        gap(600),
        say('Tightening the Address type.', 800),
        gap(),
        call('Update(src/types.ts)', 800),
        res('Added Address interface'),
        plus(8, 'postcode: string'),
        plus(9, 'country: CountryCode'),
        gap(),
        call('Bash(npm run typecheck)', 950),
        ok('0 errors'),
        gap(),
        say('Checkout types are strict now.', 1100)
      ],
      'src/checkout.ts',
      'validateAddress',
      1.13
    )
  },
  {
    agentId: 'gemini',
    agentLabel: 'Gemini',
    cmd: work(
      [
        say('Enabling route prefetching on hover.', 800),
        gap(),
        call('Read(src/router.ts)'),
        res('Read 19 lines'),
        gap(),
        call('Update(src/router.ts)', 800),
        res('Updated src/router.ts with 9 additions'),
        plus(22, 'const links = document.querySelectorAll(a[data-route])'),
        plus(23, 'links.forEach(l => l.addEventListener(mouseenter, warm))'),
        gap(),
        call('Bash(npm run build)', 1000),
        ok('bundle 214 kB  (-8 kB)'),
        gap(),
        say('Route prefetching enabled.', 1100),
        gap(600),
        say('Adding preload hints for the top routes.', 800),
        gap(),
        call('Update(index.html)', 800),
        res('Added 3 preload links'),
        plus(12, 'link rel=preload as=script href=/cart.js'),
        gap(),
        call('Bash(npm run build)', 1000),
        ok('LCP 1.9s -> 1.4s'),
        gap(),
        say('Navigation feels instant now.', 1100)
      ],
      'src/router.ts',
      'prefetchRoutes',
      0.89
    )
  },
  {
    agentId: 'claude',
    agentLabel: 'Claude Code',
    cmd: work(
      [
        say('Registering a service worker for offline cache.', 800),
        gap(),
        call('Read(src/index.ts)'),
        res('Read 11 lines'),
        gap(),
        call('Update(src/index.ts)', 800),
        res('Updated src/index.ts with 4 additions'),
        plus(7, 'if (navigator.serviceWorker) {'),
        plus(8, '  navigator.serviceWorker.register(/sw.js)'),
        plus(9, '}'),
        gap(),
        call('Bash(npm run build)', 1000),
        ok('built in 2.1s'),
        gap(),
        say('Offline cache verified.', 1100),
        gap(600),
        say('Adding a cache-first strategy for assets.', 800),
        gap(),
        call('Write(public/sw.js)', 800),
        res('Created public/sw.js'),
        plus(1, 'self.addEventListener(fetch, onFetch)'),
        plus(2, 'const CACHE = storefront-v2'),
        gap(),
        call('Bash(npm run build)', 1000),
        ok('precached 24 assets'),
        gap(),
        say('App works offline.', 1100)
      ],
      'src/index.ts',
      'registerServiceWorker',
      1.22
    )
  },
  {
    agentId: 'codex',
    agentLabel: 'Codex',
    cmd: work(
      [
        say('Adding dark-mode design tokens.', 800),
        gap(),
        call('Read(src/styles.css)'),
        res('Read 6 lines'),
        gap(),
        call('Update(src/styles.css)', 800),
        res('Updated src/styles.css with 12 additions'),
        plus(4, '--bg-elev: #16161a;'),
        plus(5, '--text-dim: #8b8b93;'),
        plus(6, '--border: #24242b;'),
        gap(),
        call('Bash(npx stylelint src)', 900),
        ok('0 problems'),
        cont('contrast ratio AA on 12 pairs', 700),
        gap(),
        say('Dark-mode tokens landed.', 1100),
        gap(600),
        say('Applying tokens across the components.', 800),
        gap(),
        call('Update(src/components.css)', 800),
        res('Replaced 18 hard-coded colours'),
        minus(22, 'color: #ffffff;'),
        plus(22, 'color: var(--text);'),
        gap(),
        call('Bash(npx stylelint src)', 900),
        ok('0 problems'),
        gap(),
        say('Theme is consistent across the app.', 1100)
      ],
      'src/styles.css',
      'themeTokens',
      0.83
    )
  },
  {
    agentId: 'gemini',
    agentLabel: 'Gemini',
    cmd: work(
      [
        say('Profiling cart totals for hot paths.', 800),
        gap(),
        call('Read(src/cart.ts)'),
        res('Read 14 lines'),
        gap(),
        call('Update(src/cart.ts)', 800),
        res('Updated src/cart.ts with 6 additions'),
        plus(19, 'const cache = new Map()'),
        plus(20, 'if (cache.has(key)) return cache.get(key)'),
        gap(),
        call('Bash(npm run bench)', 1000),
        ok('total()   1.8ms -> 0.3ms'),
        cont('6x faster on 10k items', 700),
        gap(),
        say('Benchmarks re-run and green.', 1100),
        gap(600),
        say('Wiring cache invalidation on cart change.', 800),
        gap(),
        call('Update(src/cart.ts)', 800),
        res('Added invalidation hook'),
        plus(27, 'cache.clear()'),
        gap(),
        call('Bash(npm run bench)', 1000),
        ok('no stale reads in 10k runs'),
        gap(),
        say('Memoization is safe under mutation.', 1100)
      ],
      'src/cart.ts',
      'memoizedTotal',
      1.05
    )
  }
]

/** Two background agents each for the other projects, so tab-switching shows
 *  genuinely running work rather than empty canvases. */
const BG = {
  'payments-api': [
    {
      agentId: 'claude',
      agentLabel: 'Claude Code',
      cmd: work(
        [
          say('Hardening webhook signature checks.', 800),
          gap(),
          call('Read(src/webhooks.ts)'),
          res('Read 17 lines'),
          gap(),
          call('Update(src/webhooks.ts)', 800),
          res('Updated src/webhooks.ts with 7 additions'),
          plus(41, 'if (age > TOLERANCE) return reject(stale)'),
          gap(),
          call('Bash(npm test -- webhooks)', 950),
          ok('PASS  src/webhooks.test.ts', 1100),
          gap(600),
          say('Adding replay protection on top of that.', 800),
          gap(),
          call('Update(src/webhooks.ts)', 800),
          res('Updated src/webhooks.ts with 9 additions'),
          plus(52, 'if (seen.has(sig)) return reject(replay))'),
          plus(53, 'seen.add(sig, { ttl: TOLERANCE })'),
          gap(),
          call('Bash(npm test -- webhooks)', 950),
          ok('PASS  12 passed, 12 total'),
          gap(),
          say('Replayed deliveries are rejected.', 1100),
          gap(600),
          say('Documenting the signature contract.', 800),
          gap(),
          call('Update(docs/webhooks.md)', 800),
          res('Added a verification section'),
          plus(18, 'Signatures expire after 300s.'),
          gap(),
          call('Bash(npm run lint)', 900),
          ok('0 problems'),
          gap(),
          say('Webhook hardening is complete.', 1100)
        ],
        'src/webhooks.ts',
        'verifyTimestamp'
      )
    },
    {
      agentId: 'codex',
      agentLabel: 'Codex',
      cmd: work(
        [
          say('Adding idempotency keys to payment intents.', 800),
          gap(),
          call('Read(src/intents.ts)'),
          res('Read 15 lines'),
          gap(),
          call('Update(src/intents.ts)', 800),
          res('Updated src/intents.ts with 11 additions'),
          plus(28, 'const key = req.headers[idempotency-key]'),
          gap(),
          call('Bash(npm run lint)', 900),
          ok('0 problems', 1100),
          gap(600),
          say('Persisting keys so retries are safe across restarts.', 800),
          gap(),
          call('Update(src/store/intents.ts)', 800),
          res('Updated src/store/intents.ts with 13 additions'),
          plus(44, 'await redis.setex(key, 86400, intentId)'),
          plus(45, 'return { replayed: true, intentId }'),
          gap(),
          call('Bash(npm test -- intents)', 950),
          ok('PASS  src/intents.test.ts'),
          cont('Tests: 21 passed, 21 total', 700),
          gap(),
          say('Duplicate charges are impossible now.', 1100),
          gap(600),
          say('Backfilling the key index.', 800),
          gap(),
          call('Bash(npm run migrate)', 1000),
          ok('migrated 3 tables'),
          gap(),
          call('Bash(npm run typecheck)', 950),
          ok('0 errors'),
          gap(),
          say('Idempotency is live end to end.', 1100)
        ],
        'src/intents.ts',
        'idempotencyKey'
      )
    }
  ],
  'mobile-app': [
    {
      agentId: 'gemini',
      agentLabel: 'Gemini',
      cmd: work(
        [
          say('Fixing the profile screen layout.', 800),
          gap(),
          call('Read(src/screens/Profile.tsx)'),
          res('Read 12 lines'),
          gap(),
          call('Update(src/screens/Profile.tsx)', 800),
          res('Updated Profile.tsx with 8 additions'),
          plus(14, 'flex: 1, paddingHorizontal: 16,'),
          gap(),
          call('Bash(npm run typecheck)', 950),
          ok('0 errors', 1100),
          gap(600),
          say('Making the avatar block responsive.', 800),
          gap(),
          call('Update(src/screens/Profile.tsx)', 800),
          res('Updated Profile.tsx with 11 additions'),
          minus(22, 'width: 96, height: 96,'),
          plus(22, 'width: size, height: size,'),
          plus(23, 'borderRadius: size / 2,'),
          gap(),
          call('Bash(npm run test -- Profile)', 950),
          ok('PASS  Profile.test.tsx'),
          gap(),
          say('Profile scales cleanly on tablets.', 1100),
          gap(600),
          say('Pulling the shared spacing scale in.', 800),
          gap(),
          call('Update(src/theme/spacing.ts)', 800),
          res('Added a 4pt spacing scale'),
          plus(3, 'export const space = [0, 4, 8, 16, 24, 32]'),
          gap(),
          call('Bash(npm run typecheck)', 950),
          ok('0 errors'),
          gap(),
          say('Layout is consistent across screens.', 1100)
        ],
        'src/screens/Profile.tsx',
        'useProfile'
      )
    },
    {
      agentId: 'claude',
      agentLabel: 'Claude Code',
      cmd: work(
        [
          say('Adding retry with backoff to the api client.', 800),
          gap(),
          call('Read(src/lib/api.ts)'),
          res('Read 9 lines'),
          gap(),
          call('Update(src/lib/api.ts)', 800),
          res('Updated src/lib/api.ts with 14 additions'),
          plus(12, 'await sleep(2 ** attempt * 100)'),
          gap(),
          call('Bash(npm test -- api)', 950),
          ok('PASS  src/lib/api.test.ts', 1100),
          gap(600),
          say('Adding jitter so retries do not stampede.', 800),
          gap(),
          call('Update(src/lib/api.ts)', 800),
          res('Updated src/lib/api.ts with 6 additions'),
          plus(18, 'const jitter = Math.random() * 100'),
          plus(19, 'await sleep(backoff + jitter)'),
          gap(),
          call('Bash(npm test -- api)', 950),
          ok('PASS  18 passed, 18 total'),
          gap(),
          say('Retry storms are smoothed out.', 1100),
          gap(600),
          say('Surfacing failures to the user.', 800),
          gap(),
          call('Update(src/lib/errors.ts)', 800),
          res('Added a typed ApiError'),
          plus(7, 'export class ApiError extends Error {'),
          plus(8, '  constructor(public status: number) {'),
          gap(),
          call('Bash(npm run typecheck)', 950),
          ok('0 errors'),
          gap(),
          say('The api client is production ready.', 1100)
        ],
        'src/lib/api.ts',
        'withRetry'
      )
    }
  ]
}

app.disableHardwareAcceleration()
const errors = []

app.whenReady().then(async () => {
  fs.mkdirSync(SIGNAL, { recursive: true })
  for (const f of ['ready', 'go', 'done']) fs.rmSync(join(SIGNAL, f), { force: true })

  const win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: 0,
    y: 0,
    show: true,
    // A fixed, unique caption so the recorder can grab THIS WINDOW by title
    // (-i title=...) instead of the whole desktop. Desktop capture would put
    // whatever else is on screen into the promo.
    title: CAPTURE_TITLE,
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
  // The renderer's <title> would otherwise overwrite the caption the recorder
  // matches on.
  win.on('page-title-updated', (e) => {
    e.preventDefault()
    win.setTitle(CAPTURE_TITLE)
  })
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) errors.push(message)
  })
  registerIpc(() => win)

  // Every snippet is an expression. Wrap it so a thrown renderer error comes back
  // as data instead of rejecting -- an unhandled rejection here silently stalls the
  // whole timeline with no diagnostics.
  const js = async (code) => {
    // Must be async + await: an async snippet would otherwise put a Promise in
    // `v`, which structured clone rejects ("An object could not be cloned").
    const wrapped = `(async () => { try { return { ok: true, v: await (${code}) } } catch (e) { return { ok: false, error: String((e && e.stack) || e) } } })()`
    let r
    try {
      r = await win.webContents.executeJavaScript(wrapped, true)
    } catch (e) {
      log('!! executeJavaScript failed: ' + e.message)
      return null
    }
    if (!r || !r.ok) {
      log('!! renderer error: ' + (r ? r.error : 'no result') + '  <<< ' + code.slice(0, 90))
      return null
    }
    return r.v
  }

  await win.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  log('renderer loaded')

  // Point the app at the demo projects, then reload so the app's own
  // restoreWorkspaces() opens them exactly as it would on a normal launch.
  await js(`(() => {
    localStorage.setItem('vectro.openWorkspaces', ${JSON.stringify(JSON.stringify({ paths: PATHS, active: PATHS[0] }))});
    localStorage.setItem('vectro.recent', ${JSON.stringify(JSON.stringify(PATHS.map((p, i) => ({ path: p, name: NAMES[i] }))))});
    return true
  })()`)
  win.reload()
  await new Promise((r) => win.webContents.once('did-finish-load', r))
  log('reloaded with demo workspaces')

  // Page-side helpers (re-installed after every load).
  const installHelpers = () =>
    js(`(() => {
      window.__demo = {
        S() { return window.__agentStore.getState() },
        AW() { const s = this.S(); return s.liveWorkspaces.find(w => w.id === s.activeWorkspaceId) },
        ids() { const w = this.AW(); return w ? w.agents.map(a => a.id) : [] },
        // WorkspaceSession.path was renamed to defaultPath (store.ts:178). Accept
        // both so this script works against an older build in out/ as well as a
        // current one -- a silent null here breaks every activate() downstream.
        wsPath(w) { return w.defaultPath != null ? w.defaultPath : w.path },
        wsId(path) { const w = this.S().liveWorkspaces.find(w => this.wsPath(w) === path); return w ? w.id : null },
        count() { return this.S().liveWorkspaces.length }
      };
      return true
    })()`)
  await installHelpers()

  // Wait for all three tabs to restore.
  for (let i = 0; i < 60; i++) {
    if ((await js(`window.__demo.count()`)) >= 3) break
    await sleep(500)
  }
  log('workspaces restored: ' + (await js(`window.__demo.count()`)))

  // Confirm every action the timeline drives actually exists on the store.
  const missing = await js(`(() => {
    const s = window.__demo.S();
    return ['setSelected','focusTerminal','clearFocus','setActiveWorkspace','addAgent',
            'openFilePanel','openFile','closeFilePanel','setDiffAgentId','setLayoutMode',
            'setSetting','relayout','removeAgent']
      .filter(k => typeof s[k] !== 'function')
  })()`)
  log('missing store actions: ' + (missing && missing.length ? missing.join(', ') : 'none'))

  // Force worktree isolation + PowerShell so every card gets a canvas/<id> branch
  // chip and our PowerShell work strings run in the right shell.
  await js(`(() => {
    window.__agentStore.setState(s => ({ settings: { ...s.settings, defaultIsolation: 'worktree', defaultShellId: 'powershell' } }));
    return window.__demo.S().settings.defaultIsolation
  })()`)

  // ---- Terminal look, set BEFORE any card exists so frame one is already right.
  // fontSize is clamped 9-22 (store.ts:452) and applies live without a respawn
  // (TerminalPane.tsx:1115). 16 stays legible after a 1080p -> phone downscale.
  // terminalOpacity is clamped 0.4-1; 0.62 lets the wallpaper read through the
  // glass without costing terminal contrast.
  await js(`(() => {
    const set = window.__demo.S().setSetting;
    set('theme', 'dark');
    set('fontSize', ${CAPTURE ? CAP_FONT : 16});
    set('fontFamily', 'Cascadia Code, Consolas, monospace');
    set('terminalOpacity', 0.62);
    set('scrollback', 4000);
    // Beat E reveals the wallpaper and morphs the accent -- but settings persist
    // to localStorage ('vectro.settings'), so on every run after the first they
    // are ALREADY applied at beat A and the reveal is a silent no-op. Reset them
    // here so each take starts from the same clean state and the beat always lands.
    set('wallpaper', null);
    set('accent', '#ff453a');
    return JSON.stringify(window.__demo.S().settings)
  })()`)
  log('terminal look applied + appearance reset for beat E')

  // ---- Build a wallpaper for the appearance beat.
  // Drawn in the renderer (a canvas is the only dependency-free PNG encoder we
  // have) and written to disk, because settings.wallpaper is an absolute PATH
  // that main re-reads through wallpaper:read -> data URL (ipc.ts:232).
  const WALLPAPER = join(DEMO_ROOT, 'wallpaper.png')
  const dataUrl = await js(`(() => {
    const c = document.createElement('canvas');
    c.width = 2560; c.height = 1440;
    const x = c.getContext('2d');
    x.fillStyle = '#07070a';
    x.fillRect(0, 0, c.width, c.height);
    const glow = (cx, cy, r, col) => {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, col);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, c.width, c.height);
    };
    glow(c.width * 0.26, c.height * 0.20, 1150, 'rgba(255,69,58,0.34)');
    glow(c.width * 0.80, c.height * 0.74, 1250, 'rgba(99,102,241,0.30)');
    glow(c.width * 0.60, c.height * 0.08, 780, 'rgba(20,184,166,0.15)');
    return c.toDataURL('image/png')
  })()`)
  if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
    fs.writeFileSync(WALLPAPER, Buffer.from(dataUrl.split(',')[1], 'base64'))
    log('wallpaper written: ' + WALLPAPER)
  } else {
    log('!! wallpaper generation failed — the appearance beat will skip it')
  }

  const add = (a) =>
    js(
      `(() => { window.__demo.S().addAgent(${JSON.stringify({
        command: a.cmd,
        agentId: a.agentId,
        agentLabel: a.agentLabel,
        shellId: 'powershell'
      })}); return window.__demo.ids().length })()`
    )
  const activate = async (path) => {
    const id = await js(`window.__demo.wsId(${JSON.stringify(path)})`)
    if (!id) {
      const known = await js(
        `JSON.stringify(window.__demo.S().liveWorkspaces.map(w => window.__demo.wsPath(w)))`
      )
      log('!! activate FAILED for ' + path + ' known=' + known)
      return null
    }
    await js(`(() => { window.__demo.S().setActiveWorkspace(${JSON.stringify(id)}); return true })()`)
    // A hidden workspace's xterm canvases don't repaint on re-show, so the
    // incoming tab briefly renders the PREVIOUS project's terminal text. Kicking
    // a resize makes the fit addon redraw every visible terminal.
    //
    // Background panes buffer their PTY output and flush + refit on show
    // (terminalRegistry.ts:17-35). Under --capture that refit loses a race and
    // throws "Cannot read properties of undefined (reading 'dimensions')",
    // leaving the incoming workspace's terminals BLANK for the whole beat --
    // capturePage at ~11fps starves the rAF the fit depends on. A second resize
    // after a longer settle re-runs it once the canvas actually has dimensions.
    await sleep(CAPTURE ? 700 : 400)
    await js(`(() => { window.dispatchEvent(new Event('resize')); window.__demo.S().relayout(); return true })()`)
    await sleep(CAPTURE ? 650 : 450)
    if (CAPTURE) {
      await js(`(() => { window.dispatchEvent(new Event('resize')); return true })()`)
      await sleep(500)
    }
    const now = await js(`(() => { const w = window.__demo.AW(); return w ? w.name : null })()`)
    log('active -> ' + now)
    return id
  }

  // Opening a project auto-creates one terminal, and it predates our worktree
  // setting (so it's 'shared', with no branch). Left in place it would make the
  // hero canvas 7 cards instead of 6 and hand the diff beat an agent that has no
  // worktree -- clear the canvas before staging each project.
  const clearAgents = () =>
    js(`(() => {
      const w = window.__demo.AW();
      const ids = w.agents.map(a => a.id);
      ids.forEach(id => window.__demo.S().removeAgent(id, { keepWorktree: false }));
      return window.__demo.ids().length
    })()`)

  // ---- Pre-roll (off camera): stock the two background projects ----
  for (const name of ['payments-api', 'mobile-app']) {
    await activate(join(DEMO_ROOT, name))
    await sleep(600)
    log('cleared ' + name + ' -> ' + (await clearAgents()))
    await sleep(500)
    for (const a of BG[name]) {
      await add(a)
      await sleep(700)
    }
    log('seeded background project ' + name)
  }
  await activate(PATHS[0])
  await sleep(600)
  log('cleared storefront -> ' + (await clearAgents()))
  await sleep(1200)
  // In --capture mode none of this applies: capturePage reads the window's own
  // surface, so the window neither needs to be fullscreen nor in front, and
  // forcing topmost would just hijack the user's screen for no reason.
  if (!CAPTURE) {
    await win.setFullScreen(true)
    // Force it in front: the WMI-detached launch does not steal focus, so without
    // this the app can sit behind whatever the user already had open.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.show()
    win.focus()
    win.moveTop()
    win.setTitle(CAPTURE_TITLE)
  }
  await sleep(1500)
  // The canvas sizes itself from the stage element; without a relayout after the
  // fullscreen resize the tiles keep their pre-resize geometry and leave a dead
  // band down the right-hand side.
  await js(`(() => { window.__demo.S().relayout(); return true })()`)
  await sleep(400)
  log(
    'census: ' +
      (await js(
        `JSON.stringify(window.__demo.S().liveWorkspaces.map(w => w.name + ':' + w.agents.length))`
      ))
  )
  // Re-assert topmost immediately before signalling ready: entering fullscreen
  // can drop the flag, and anything the user clicks in the meantime steals the
  // z-order. The recorder's coverage gate fails closed if this doesn't hold.
  if (!CAPTURE) {
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
    win.focus()
    await sleep(600)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.moveTop()
  }
  log('READY — waiting for recorder')

  fs.writeFileSync(join(SIGNAL, 'ready'), String(process.pid))
  if (!SOLO && !CAPTURE) {
    for (let i = 0; i < 240; i++) {
      if (fs.existsSync(join(SIGNAL, 'go'))) break
      await sleep(500)
    }
  }

  // ---- Frame capture, running concurrently with the timeline -------------
  // Self-correcting cadence: capturePage + JPEG costs ~80ms, so a naive interval
  // would drift and the encoded video would play at the wrong speed. We record
  // the ACHIEVED rate and hand that to ffmpeg, which keeps playback real-time.
  let capN = 0
  let capStop = false
  let capDone = Promise.resolve()
  const capStarted = Date.now()
  // Real wall-clock time of every frame. capturePage is NOT uniform -- an empty
  // canvas encodes far faster than six live panes with a backdrop-filter -- so
  // encoding at a single average fps makes the early beats play fast and the
  // dense ones slow. Per-frame timestamps let ffmpeg's concat demuxer reproduce
  // the true timing.
  const capTimes = []
  if (CAPTURE) {
    fs.rmSync(VFRAMES, { recursive: true, force: true })
    fs.mkdirSync(VFRAMES, { recursive: true })
    const TARGET_FPS = 12
    const STEP = 1000 / TARGET_FPS
    capDone = (async () => {
      while (!capStop) {
        const wait = capStarted + capN * STEP - Date.now()
        if (wait > 0) await sleep(wait)
        try {
          const img = await win.webContents.capturePage()
          const buf = img.toJPEG(94)
          // The very first capture can land before the window has painted, and
          // toJPEG on an empty NativeImage returns a ZERO-BYTE buffer. Written to
          // disk it becomes an unopenable frame that aborts the whole ffmpeg
          // concat ("Impossible to open v00000.jpg") -- drop it instead.
          if (buf.length > 0) {
            fs.writeFileSync(join(VFRAMES, `v${String(capN).padStart(5, '0')}.jpg`), buf)
            capTimes.push(Date.now())
            capN++
          }
        } catch {
          /* a dropped frame is better than aborting the take */
        }
      }
    })()
    log('frame capture started')
  }

  // ================= TIMELINE (~55s) =================
  // A hero · B six agents · D branches · E appearance
  // F project switching · G file panel · H diff+merge · I outro
  const T = Date.now()
  const beat = (n) => log(`beat ${n} @ ${((Date.now() - T) / 1000).toFixed(1)}s`)

  // Stills at each beat -- the only way to actually verify what the recording
  // will contain (the log alone can't tell you the canvas looks right).
  const SHOTS = join(DEMO_ROOT, 'shots')
  fs.mkdirSync(SHOTS, { recursive: true })
  const shot = async (name) => {
    try {
      const img = await win.capturePage()
      fs.writeFileSync(join(SHOTS, name + '.png'), img.toPNG())
    } catch (e) {
      log('shot failed ' + name + ': ' + e.message)
    }
  }

  beat('A hero hold')
  await sleep(900)
  await shot('a-hero')
  await sleep(200)

  beat('B six agents appear')
  // Cards land fast, then a longer hold: the sessions are the point of this beat
  // and the viewer needs time to actually read one.
  for (const a of HERO) {
    await add(a)
    await sleep(420)
  }
  await sleep(3600)
  await shot('b-six-agents')

  beat('D worktree branches')
  // Deliberately NOT focusTerminal(). Maximising remounts the pane, which restarts
  // its shell from line one and leaves that card nearly empty for the rest of the
  // video -- unacceptable in the top-left slot. The canvas/<id> branch chips are
  // legible in the grid, so a single-card selection carries the beat instead.
  const panelAgent = await js(`(() => {
    const w = window.__demo.AW();
    const wt = w.agents.filter(x => x.isolation === 'worktree' && x.branch);
    const a = wt[3] || wt[0] || w.agents[0];   // bottom row -- keeps the top row pristine
    return a ? a.id : null
  })()`)
  log('file-panel agent: ' + panelAgent)
  await js(`(() => { window.__demo.S().setSelected([${JSON.stringify(panelAgent)}]); return true })()`)
  await sleep(2400)
  await shot('d-branches')
  await sleep(600)

  beat('E make it yours — accent morph + wallpaper')
  // The accent is tweened by writing the CSS custom properties DIRECTLY rather
  // than calling setSetting per frame: setSetting persists to localStorage on
  // every call, so a 60fps tween through it would issue ~200 writes and stutter.
  // The maths mirrors applyAccent() (accent.ts:32) so the tween and the committed
  // value can't drift. App.tsx's accent effect only re-runs when settings.accent
  // changes, so it will not fight these writes mid-tween.
  const morph = await js(`(async () => {
    const stops = ['#ff453a', '#8b5cf6', '#2f6bff', '#14b8a6', '#ff453a'];
    const toRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] };
    const mix = (c, t, tgt) => c.map(v => Math.round(v + (tgt - v) * t));
    const paint = (rgb) => {
      const s = document.documentElement.style;
      s.setProperty('--accent-rgb', rgb.join(', '));
      s.setProperty('--accent-2', 'rgb(' + mix(rgb, 0.24, 255).join(', ') + ')');
      s.setProperty('--accent-active', 'rgb(' + mix(rgb, 0.28, 0).join(', ') + ')');
    };
    for (let i = 0; i < stops.length - 1; i++) {
      const a = toRgb(stops[i]), b = toRgb(stops[i + 1]), t0 = performance.now();
      await new Promise((done) => {
        const step = () => {
          const p = Math.min(1, (performance.now() - t0) / 900);
          const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;  // easeInOutQuad
          paint([0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * e)));
          p < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    }
    // Commit the final value so the store agrees with what is on screen.
    window.__demo.S().setSetting('accent', stops[stops.length - 1]);
    return window.__demo.S().settings.accent
  })()`)
  log('accent morph ended on: ' + morph)
  await shot('e1-accent')

  // Wallpaper last: it also flips body.has-wallpaper, which turns on the frosted
  // backdrop-filter (styles.css:2196) — the single most expensive effect in the
  // app, so it goes in once the colour tween has finished animating.
  await js(`(() => { window.__demo.S().setSetting('wallpaper', ${JSON.stringify(WALLPAPER)}); return true })()`)
  await sleep(1500)
  const wall = await js(`(() => JSON.stringify({
    set: !!window.__demo.S().settings.wallpaper,
    onBody: document.body.classList.contains('has-wallpaper'),
    painted: !!document.querySelector('.wallpaper')
  }))()`)
  log('wallpaper: ' + wall)
  await sleep(1400)
  await shot('e2-wallpaper')
  await sleep(400)

  beat('F project switching')
  await activate(join(DEMO_ROOT, 'payments-api'))
  await sleep(1800)
  await shot('f1-payments-api')
  await sleep(200)
  await activate(join(DEMO_ROOT, 'mobile-app'))
  await sleep(1600)
  await shot('f2-mobile-app')
  await sleep(200)
  await activate(PATHS[0])
  await sleep(1600)

  beat('G file panel on an agent worktree')
  await js(`(() => {
    window.__demo.S().openFilePanel({ kind: 'agent', agentId: ${JSON.stringify(panelAgent)} });
    return true
  })()`)
  await sleep(1600)
  await js(`(() => { window.__demo.S().openFile('src/cart.ts'); return true })()`)
  await sleep(1000)
  log(
    'file panel: ' +
      (await js(`(() => {
        const w = window.__demo.AW();
        return JSON.stringify({
          open: w.filePanel.open,
          scope: w.filePanel.scope && w.filePanel.scope.kind,
          openPath: w.filePanel.openPath,
          inDom: !!document.querySelector('.filepanel, .file-panel, [class*="filepanel"]')
        })
      })()`))
  )
  await sleep(1700)
  await shot('g-file-panel')
  await sleep(300)
  await js(`(() => { window.__demo.S().closeFilePanel(); return true })()`)
  await sleep(900)

  beat('H diff + merge')
  // Merge the LAST card, not the hero. Merging leaves that agent idle with a
  // blank terminal for several seconds, and the video ends on this beat -- so the
  // blank belongs bottom-right behind the modal, not in the top-left hero slot.
  const mergeTarget = await js(`(() => {
    const w = window.__demo.AW();
    const wt = w.agents.filter(x => x.isolation === 'worktree' && x.branch);
    const a = wt[wt.length - 1] || w.agents[w.agents.length - 1];
    return a ? a.id : null
  })()`)
  log('merge target: ' + mergeTarget)
  // Return a STRING -- the raw diff object contains values Electron's structured
  // clone rejects ("An object could not be cloned").
  const roster = await js(`(() => {
    const w = window.__demo.AW();
    return JSON.stringify({
      ws: w.name, path: window.__demo.wsPath(w), mergeTarget: ${JSON.stringify(mergeTarget)},
      agents: w.agents.map(a => ({ id: a.id.slice(0, 13), iso: a.isolation, br: a.branch || null, st: a.status }))
    })
  })()`)
  log('roster: ' + roster)
  const probe = await js(`(async () => {
    const w = window.__demo.AW();
    const d = await window.api.git.diff(window.__demo.wsPath(w), ${JSON.stringify(mergeTarget)});
    return JSON.stringify({
      base: w.baseBranch, branch: d && d.branch,
      files: d && d.files ? d.files.length : -1,
      untracked: d && d.untracked ? d.untracked.length : -1,
      error: d && d.error ? String(d.error) : null,
      hasChanges: d ? d.hasChanges : null,
      diffLen: d && d.diff ? d.diff.length : 0
    })
  })()`)
  log('diff probe: ' + probe)
  await js(`(() => { window.__demo.S().setDiffAgentId(${JSON.stringify(mergeTarget)}); return true })()`)
  await sleep(1900)
  await shot('h1-diff')
  // The button stays disabled while the diff loads (busy || !hasChanges ||
  // selCount === 0), so poll instead of clicking blind.
  let merged = 'never-enabled'
  for (let i = 0; i < 20; i++) {
    const st = await js(`(() => {
      const b = document.querySelector('.review__btn--merge');
      if (!b) return { state: 'no-button' };
      return { state: b.disabled ? 'disabled' : 'ready', label: (b.textContent || '').trim() }
    })()`)
    if (st && st.state === 'ready') {
      merged = await js(`(() => {
        const b = document.querySelector('.review__btn--merge');
        const label = (b.textContent || '').trim();
        b.click();
        return 'clicked:' + label
      })()`)
      break
    }
    if (i === 0) log('merge button: ' + JSON.stringify(st))
    await sleep(400)
  }
  log('merge: ' + merged)
  await sleep(1200)
  await shot('h2-merged-confetti')
  await sleep(2500)
  log(
    'post-merge hero: ' +
      (await js(`(() => {
        const w = window.__demo.AW();
        const a = w.agents.find(x => x.id === ${JSON.stringify(mergeTarget)});
        return a ? JSON.stringify({ status: a.status, branch: a.branch, hasPty: !!a.ptyId }) : 'gone'
      })()`))
  )

  // Close ON the success modal. Merging remounts the merged agent's pane, so
  // dismissing the panel and returning to the grid would end the video on a card
  // that is still refilling -- and it is the prominent top-left one.
  beat('I outro on merge success')
  await sleep(3200)
  await shot('i-outro')
  await sleep(400)
  log('TIMELINE COMPLETE — ' + ((Date.now() - T) / 1000).toFixed(1) + 's')
  if (CAPTURE) {
    capStop = true
    await capDone
    const secs = (Date.now() - capStarted) / 1000
    const fps = capN / secs
    fs.writeFileSync(join(VFRAMES, 'fps.txt'), fps.toFixed(3))
    // ffmpeg concat demuxer: each frame holds for its measured duration, so the
    // encode reproduces real time rather than an average. The last entry must be
    // repeated without a duration or the demuxer drops the final frame.
    const lines = []
    for (let i = 0; i < capN; i++) {
      const dur = ((i + 1 < capN ? capTimes[i + 1] : Date.now()) - capTimes[i]) / 1000
      lines.push(`file 'v${String(i).padStart(5, '0')}.jpg'`)
      lines.push(`duration ${Math.max(0.008, dur).toFixed(4)}`)
    }
    lines.push(`file 'v${String(capN - 1).padStart(5, '0')}.jpg'`)
    fs.writeFileSync(join(VFRAMES, 'concat.txt'), lines.join('\n') + '\n')
    const spread = capTimes.slice(1).map((t, i) => t - capTimes[i])
    log(
      `captured ${capN} frames in ${secs.toFixed(1)}s -> ${fps.toFixed(2)} fps avg ` +
        `(frame gap min ${Math.min(...spread)}ms / max ${Math.max(...spread)}ms)`
    )
  }
  if (errors.length) log('console errors: ' + errors.slice(0, 5).join(' | '))

  fs.writeFileSync(join(SIGNAL, 'done'), String((Date.now() - T) / 1000))
  await sleep(1500)
  app.exit(0)
})

setTimeout(() => {
  log('TIMEOUT')
  try {
    fs.writeFileSync(join(SIGNAL, 'done'), 'timeout')
  } catch {
    /* ignore */
  }
  app.exit(3)
}, 300000)
