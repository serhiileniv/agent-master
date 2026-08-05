import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Emitted separately so integration tests can drive the real handlers.
          ipc: resolve(__dirname, 'src/main/ipc.ts'),
          // Ditto: envpath-smoke drives prime()/resolvedPath() directly, and it
          // must be the REAL built module, not a re-export bolted onto ipc.ts.
          'env-path': resolve(__dirname, 'src/main/env-path.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      // electron-vite's renderer preset hard-codes `minify: false`, so until
      // this line the app shipped UNMINIFIED — 3.20MB of renderer JS, comments
      // and all, for V8 to read and compile on every single launch. Minified
      // that is 1.94MB (entry 1449kB -> 826kB, FileView 873kB -> 426kB).
      //
      // Renderer only. main + preload total ~52kB, where minifying would save
      // nothing worth having and would make the stack traces in electron-log —
      // the only diagnostics we get back from a user's machine — unreadable.
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
