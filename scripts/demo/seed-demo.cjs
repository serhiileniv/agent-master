// Seeds throwaway git repos for the Agent Master promo video.
//
// The promo shows agents working in isolated git worktrees, browsing files, and
// merging a real diff -- so the demo projects must be REAL git repos with real
// committed content. Nothing here touches the user's own projects.
//
//   node scripts/demo/seed-demo.cjs          # create (idempotent)
//   node scripts/demo/seed-demo.cjs --clean  # remove and recreate
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const { join } = require('path')

const ROOT = join(os.tmpdir(), 'agentmaster-demo')

/** Projects become the tab names in the video, so they read like real work. */
const PROJECTS = [
  {
    name: 'storefront',
    files: {
      'package.json': j({ name: 'storefront', version: '2.4.0', private: true }),
      'README.md': '# storefront\n\nCustomer-facing web storefront.\n',
      'src/index.ts': ts('bootstrap', ['mountApp', 'hydrateCart']),
      'src/router.ts': ts('router', ['route', 'navigate', 'prefetch']),
      'src/cart.ts': ts('cart', ['addItem', 'removeItem', 'total']),
      'src/checkout.ts': ts('checkout', ['startSession', 'confirmOrder']),
      'src/styles.css': ':root {\n  --brand: #ff453a;\n  --bg: #0b0b0d;\n}\n'
    }
  },
  {
    name: 'payments-api',
    files: {
      'package.json': j({ name: 'payments-api', version: '1.9.2', private: true }),
      'README.md': '# payments-api\n\nPayment intents, refunds, webhooks.\n',
      'src/server.ts': ts('server', ['listen', 'shutdown']),
      'src/intents.ts': ts('intents', ['createIntent', 'captureIntent']),
      'src/webhooks.ts': ts('webhooks', ['verifySignature', 'dispatch']),
      'src/db.ts': ts('db', ['query', 'transaction'])
    }
  },
  {
    name: 'mobile-app',
    files: {
      'package.json': j({ name: 'mobile-app', version: '0.8.1', private: true }),
      'README.md': '# mobile-app\n\nReact Native client.\n',
      'src/App.tsx': ts('App', ['App']),
      'src/screens/Home.tsx': ts('Home', ['HomeScreen']),
      'src/screens/Profile.tsx': ts('Profile', ['ProfileScreen']),
      'src/lib/api.ts': ts('api', ['get', 'post'])
    }
  }
]

function j(o) {
  return JSON.stringify(o, null, 2) + '\n'
}

/** Plausible-looking source so the file tree and editor have real content. */
function ts(mod, fns) {
  const body = fns
    .map((f) => `export function ${f}(): void {\n  // TODO: ${mod}.${f}\n}\n`)
    .join('\n')
  return `// ${mod}.ts\n\n${body}`
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString()
}

function seed(p) {
  const dir = join(ROOT, p.name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [rel, content] of Object.entries(p.files)) {
    const full = join(dir, rel)
    fs.mkdirSync(join(full, '..'), { recursive: true })
    fs.writeFileSync(full, content)
  }
  git(dir, ['init', '-b', 'main'])
  // Local identity only -- never touches the user's global git config.
  git(dir, ['config', 'user.email', 'demo@agentmaster.local'])
  git(dir, ['config', 'user.name', 'Agent Master Demo'])
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'Initial commit'])
  return dir
}

if (process.argv.includes('--clean') && fs.existsSync(ROOT)) {
  fs.rmSync(ROOT, { recursive: true, force: true })
}
fs.mkdirSync(ROOT, { recursive: true })

const paths = []
for (const p of PROJECTS) {
  const dir = join(ROOT, p.name)
  if (fs.existsSync(join(dir, '.git'))) {
    console.log('[seed] exists  ' + dir)
  } else {
    seed(p)
    console.log('[seed] created ' + dir)
  }
  paths.push(dir)
}

fs.writeFileSync(join(ROOT, 'projects.json'), JSON.stringify(paths, null, 2))
console.log('[seed] root: ' + ROOT)
module.exports = { ROOT, PROJECTS, paths }
