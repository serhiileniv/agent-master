import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The updater's failure path. UpdateBanner renders only when `update` is
// non-null (UpdateBanner.tsx:24), so a checkForUpdate() that returns null on a
// broken feed leaves the user with no banner AND no error — silently stranded
// on an old version. These tests pin the fallback to the Releases API that
// keeps a signal reaching the user.

const checkForUpdates = vi.fn()

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.26', getPath: () => '/tmp' },
  ipcMain: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    checkForUpdates,
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    get logger() {
      return null
    },
    set logger(_v: unknown) {}
  }
}))

vi.mock('electron-log/main', () => ({
  default: { warn: vi.fn(), transports: { file: { level: 'info' } } }
}))

const releaseJson = (tag: string): Response =>
  ({ ok: true, json: async () => ({ tag_name: tag }) }) as unknown as Response

describe('checkForUpdate fallback', () => {
  beforeEach(() => {
    vi.resetModules()
    checkForUpdates.mockReset()
    // Only meaningful on win32, where canAutoUpdate() is true; the suite runs
    // there. Elsewhere the updater branch is skipped and the REST path is the
    // only path anyway, which these assertions still hold for.
    process.env.AGENTMASTER_UPDATE_CHECK = '1'
  })

  afterEach(() => {
    delete process.env.AGENTMASTER_UPDATE_CHECK
    vi.unstubAllGlobals()
  })

  it('falls back to the Releases API when the updater check throws', async () => {
    checkForUpdates.mockRejectedValue(new Error('Unable to find latest.yml'))
    const fetchMock = vi.fn(async () => releaseJson('v0.1.30'))
    vi.stubGlobal('fetch', fetchMock)

    const { checkForUpdate } = await import('./update')
    const res = await checkForUpdate()

    // The regression: this used to be null, so no banner ever rendered.
    expect(res).not.toBeNull()
    expect(res?.latest).toBe('0.1.30')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does NOT fall back when the updater succeeds and reports no update', async () => {
    // A successful "you're current" must stay a single request — falling
    // through here would double every check against GitHub's rate limit.
    checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.1.26' } })
    const fetchMock = vi.fn(async () => releaseJson('v0.1.30'))
    vi.stubGlobal('fetch', fetchMock)

    const { checkForUpdate } = await import('./update')
    const res = await checkForUpdate()

    expect(res).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the updater result directly when it finds an update', async () => {
    checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.1.30' } })
    const fetchMock = vi.fn(async () => releaseJson('v9.9.9'))
    vi.stubGlobal('fetch', fetchMock)

    const { checkForUpdate } = await import('./update')
    const res = await checkForUpdate()

    expect(res?.latest).toBe('0.1.30')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still returns null when BOTH the updater and the API fail', async () => {
    // Offline. Staying silent is correct — there is nothing the user can act on.
    checkForUpdates.mockRejectedValue(new Error('ENOTFOUND'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ENOTFOUND')
      })
    )

    const { checkForUpdate } = await import('./update')
    await expect(checkForUpdate()).resolves.toBeNull()
  })

  it('returns null rather than throwing when the API returns non-OK', async () => {
    checkForUpdates.mockRejectedValue(new Error('bad feed'))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response))

    const { checkForUpdate } = await import('./update')
    await expect(checkForUpdate()).resolves.toBeNull()
  })
})
