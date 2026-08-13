import { app, ipcMain, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import log from 'electron-log/main'

// Installers are published as GitHub Releases on this repo (serhiileniv/agentmaster,
// public) — its releases/latest is the app's version feed. CI attaches them on
// every version tag; see RELEASING.md. All update traffic runs in the main
// process so the renderer never talks to the network and the production CSP
// stays strict.
//
// Two tiers:
//  - Windows (packaged): full in-place auto-update via electron-updater — the
//    new version downloads in the background (delta via .blockmap when
//    possible) and installs silently on "Restart to update" or on quit.
//  - macOS + everything else: notify-only. electron-updater refuses to install
//    into an unsigned/ad-hoc-signed mac app, so until we ship Developer-ID
//    signed builds the banner links to the download site instead. To enable
//    mac later: sign + notarize, add a `zip` target for mac in
//    electron-builder.yml, and add 'darwin' to canAutoUpdate().
const RELEASES_API = 'https://api.github.com/repos/serhiileniv/agentmaster/releases/latest'
// Send users to the download site, not the raw release: it picks the right
// installer per OS and explains the unsigned-build Gatekeeper/SmartScreen prompt.
// NOTE: must track the repo name — GitHub Pages URLs do NOT redirect on rename
// (the old /vectro-site page 404s), unlike the REST API.
const DOWNLOAD_URL = 'https://serhiileniv.github.io/agentmaster'

export interface UpdateInfo {
  current: string
  latest: string
  url: string
}

/** Push-stream of in-place update progress (Windows only; mac never sends). */
export type UpdateState =
  | { status: 'downloading'; percent: number }
  | { status: 'ready' }
  | { status: 'error'; message: string }

function canAutoUpdate(): boolean {
  // AGENTMASTER_DEV_UPDATE_CONFIG=<path to dev-app-update.yml> lets a dev run drive
  // the real electron-updater against a local feed (see scripts/ e2e harness).
  if (process.env.AGENTMASTER_DEV_UPDATE_CONFIG) return true
  return process.platform === 'win32' && app.isPackaged
}

/** "v0.1.9" | "0.1.9" → [0, 1, 9]; null when it isn't a dotted number. */
function parseVersion(v: string): number[] | null {
  const m = v.trim().replace(/^v/i, '')
  if (!/^\d+(\.\d+)*$/.test(m)) return null
  return m.split('.').map(Number)
}

/** Exported for unit tests. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return false
}

/**
 * Wire the in-place updater: state events stream to the renderer over
 * `update:state`, and `update:install` restarts into the downloaded version.
 * Registered unconditionally (the renderer may always call install; it no-ops
 * when nothing is downloaded) — but the updater itself only runs when
 * canAutoUpdate().
 */
export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  const sendState = (state: UpdateState): void => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('update:state', state)
  }

  ipcMain.on('update:install', () => {
    // The canAutoUpdate() guard makes this a no-op under AGENTMASTER_FAKE_UPDATE,
    // where 'ready' is synthetic and there is nothing real to install.
    if (!downloaded || !canAutoUpdate()) return
    // Silent NSIS reinstall into the same directory, then relaunch.
    autoUpdater.quitAndInstall(true, true)
  })

  if (!canAutoUpdate()) return

  if (process.env.AGENTMASTER_DEV_UPDATE_CONFIG) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.updateConfigPath = process.env.AGENTMASTER_DEV_UPDATE_CONFIG
  }
  // A file logger, not console: in a packaged app stdout goes nowhere, and a
  // failed update is precisely the thing you need a post-mortem for.
  // Written to the per-OS log dir (app.getPath('logs')).
  log.transports.file.level = 'info'
  autoUpdater.logger = log
  autoUpdater.autoDownload = true
  // Even if the user never clicks "Restart to update", the pending version
  // installs on normal quit, so the next launch is current.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('download-progress', (p) => {
    sendState({ status: 'downloading', percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', () => {
    downloaded = true
    sendState({ status: 'ready' })
  })
  autoUpdater.on('error', (e) => {
    // An update must never surface as an app error — log, tell the renderer so
    // the banner falls back to the download-site button, and move on.
    log.warn('[agentmaster] auto-update error:', e?.message ?? e)
    sendState({ status: 'error', message: String(e?.message ?? e) })
  })
}

let downloaded = false

/**
 * One-shot update check: resolves to the newer version if there is one, else
 * null (including on any network/API failure — an update check must never
 * surface an error). On Windows this also kicks off the background download;
 * progress then streams via `update:state`. Dev runs report null; set
 * AGENTMASTER_UPDATE_CHECK=1 to test the REST path.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Dev-only harness for the update UI: `AGENTMASTER_FAKE_UPDATE=9.9.9 npm run dev`
  // reports a synthetic newer release AND plays a fake download→ready
  // progression so the banner's whole lifecycle is visible without cutting a
  // release. Ignored in packaged builds.
  if (!app.isPackaged && process.env.AGENTMASTER_FAKE_UPDATE) {
    fakeDownloadFlow()
    return { current: app.getVersion(), latest: process.env.AGENTMASTER_FAKE_UPDATE, url: DOWNLOAD_URL }
  }

  if (canAutoUpdate()) {
    try {
      const res = await autoUpdater.checkForUpdates()
      const latest = res?.updateInfo?.version ?? ''
      const current = app.getVersion()
      if (!latest || !isNewer(latest, current)) return null
      return { current, latest, url: DOWNLOAD_URL }
    } catch (e) {
      // Deliberately fall through to the REST check rather than returning null.
      // A broken feed (corrupt latest.yml, 404, throttled CDN) used to mean the
      // banner never rendered at all — the user sat on a stale version forever
      // with no signal. The REST path answers the only question the banner
      // needs ("is there a newer version?") and degrades to the download-site
      // button, which is the same fallback the 'error' event aims for.
      log.warn('[agentmaster] auto-update check failed, falling back to releases API:', e)
    }
  }

  return checkViaReleasesApi()
}

/**
 * Version check straight off the GitHub Releases API. The only path on macOS and
 * Linux, and the fallback when electron-updater's own check fails on Windows.
 * Returns null on any failure — a check that can't reach the network must stay
 * silent rather than nag about a problem the user can't act on.
 */
async function checkViaReleasesApi(): Promise<UpdateInfo | null> {
  if (!app.isPackaged && process.env.AGENTMASTER_UPDATE_CHECK !== '1') return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(RELEASES_API, {
      // GitHub's API rejects UA-less requests with 403 — don't rely on the
      // fetch implementation's default.
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `AgentMaster/${app.getVersion()}`
      },
      signal: ctrl.signal
    })
    if (!res.ok) {
      log.warn(`[agentmaster] update check failed: HTTP ${res.status} from ${RELEASES_API}`)
      return null
    }
    const json = (await res.json()) as { tag_name?: unknown }
    const latest = typeof json.tag_name === 'string' ? json.tag_name.replace(/^v/i, '') : ''
    const current = app.getVersion()
    if (!parseVersion(latest)) {
      log.warn(`[agentmaster] update check: unparsable tag_name ${JSON.stringify(json.tag_name)}`)
      return null
    }
    if (!isNewer(latest, current)) return null
    return { current, latest, url: DOWNLOAD_URL }
  } catch (e) {
    log.warn('[agentmaster] update check failed:', e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Dev-only: synthetic downloading→ready progression for AGENTMASTER_FAKE_UPDATE. */
function fakeDownloadFlow(): void {
  let percent = 0
  const tick = (): void => {
    const w = BrowserWindow.getAllWindows()[0]
    if (!w || w.isDestroyed()) return
    percent = Math.min(100, percent + 9 + Math.round(Math.random() * 8))
    if (percent < 100) {
      w.webContents.send('update:state', { status: 'downloading', percent })
      setTimeout(tick, 350)
    } else {
      downloaded = true
      w.webContents.send('update:state', { status: 'ready' })
    }
  }
  setTimeout(tick, 1200)
}
