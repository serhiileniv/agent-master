/**
 * The on-disk home of the whole tab set.
 *
 * A corrupt or half-written file here loses every workspace the user has, so
 * this owns two protections and nothing else has to know about either:
 *
 *  - **atomicity against a crash** — write to a temp file, then rename, so the
 *    real file is only ever replaced whole.
 *  - **serialization against a second writer** — the renderer has two
 *    independent writers (the debounced layout autosave and the un-awaited
 *    flush on close), so two saves genuinely overlap. Rename is atomic against
 *    a crash but not against a second writer sharing a temp path: B could
 *    truncate and rewrite the temp file while A was mid-write, and A would
 *    then rename the spliced result into place.
 *
 * Both used to be closures inside registerIpc, reachable only by booting
 * Electron. The store takes its file path as a function because
 * app.getPath('userData') is only valid after the app is ready — and because
 * the smoke scripts reassign it before handlers are registered.
 */
import { promises as fs } from 'fs'

export interface WorkspaceStore {
  /** The saved set, or null when there is no file yet (first run) or it is
   *  unreadable. The caller decides what "no file" means — it is the signal
   *  that drives the one-time migration from the pre-workspaces layout. */
  load: () => Promise<unknown>
  /** True when the data reached disk. Saves are serialized in call order. */
  save: (data: unknown) => Promise<boolean>
}

export function createWorkspaceStore(fileFor: () => string): WorkspaceStore {
  // Saves run one at a time, in the order they arrived.
  let saveChain: Promise<boolean> = Promise.resolve(true)
  let saveSeq = 0

  return {
    async load(): Promise<unknown> {
      try {
        return JSON.parse(await fs.readFile(fileFor(), 'utf8'))
      } catch {
        return null
      }
    },

    save(data: unknown): Promise<boolean> {
      const run = async (): Promise<boolean> => {
        const target = fileFor()
        // Unique per write, so even a stray concurrent writer can't collide.
        const tmp = `${target}.${process.pid}.${++saveSeq}.tmp`
        try {
          await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
          await fs.rename(tmp, target)
          return true
        } catch (e) {
          console.error('[spymaster] workspaces:save failed:', e)
          try {
            await fs.unlink(tmp)
          } catch {
            /* the temp file may not exist — nothing to clean up */
          }
          return false
        }
      }
      // .then(run, run): one failed save must never break the chain for every
      // later one.
      saveChain = saveChain.then(run, run)
      return saveChain
    }
  }
}
