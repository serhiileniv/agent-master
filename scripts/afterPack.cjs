// electron-builder afterPack hook: ad-hoc code-sign the macOS .app, but ONLY in the
// no-credentials fallback mode. See the mac: block in electron-builder.yml.
//
// Why this exists at all: Apple Silicon refuses to launch a wholly unsigned binary,
// so a "-" (ad-hoc) signature is what makes an unsigned build runnable on the machine
// that produced it. It does NOT get a downloaded copy past Gatekeeper — a .dmg fetched
// from the web carries com.apple.quarantine and an ad-hoc signature isn't notarized, so
// macOS reports "Spy Master is damaged and can't be opened." Right-click -> Open does not
// clear that one (it only dismisses the milder "unidentified developer" dialog); the
// user has to strip the quarantine flag, which is what the README and download page say:
//
//   xattr -dr com.apple.quarantine /Applications/Spy Master.app
//
// Why it stands down when a real cert is present: an ad-hoc signature would replace the
// Developer ID one and silently produce a build that cannot be notarized. electron-builder
// documents afterPack as running BEFORE its signing step, which would make the ad-hoc
// signature merely redundant rather than destructive — but that ordering is an
// implementation detail, and the failure mode if it ever changes is a broken release that
// looks fine in CI. Skipping is free; relying on hook order is not.
const { execFileSync } = require('child_process')
const path = require('path')

/** True when electron-builder has what it needs to do a real Developer ID signing. */
function realSigningConfigured(env) {
  if (String(env.CSC_IDENTITY_AUTO_DISCOVERY).toLowerCase() === 'false') return false
  // CSC_LINK / CSC_NAME are the explicit paths; auto-discovery may also find an
  // identity in the login keychain on a developer's own machine.
  return Boolean(env.CSC_LINK || env.CSC_NAME)
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (realSigningConfigured(process.env)) {
    console.log('  • skipping ad-hoc signing — signing credentials present')
    return
  }

  const appName = context.packager.appInfo.productFilename // "Spy Master"
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  console.log(`  • ad-hoc signing  ${appPath}  (unsigned build — will need xattr on install)`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
}
