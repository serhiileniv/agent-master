# Releasing Agent Master

Installers are built by [`.github/workflows/build.yml`](.github/workflows/build.yml) and
attached as a **GitHub Release on this repo** — that's what the download site
(https://serhiileniv.github.io/agent-master) links to. The site itself is GitHub Pages
serving this repo's `gh-pages` branch. Everything lives here; there is no
cross-repo publishing and no extra token: the workflow uses the automatic
`GITHUB_TOKEN`.

## Cutting a release

```bash
# 1. bump the version in package.json (e.g. 0.1.20), commit
# 2. tag and push — the tag triggers the build, which attaches the installers
#    to a Release on this repo
git tag v0.1.20
git push origin v0.1.20
```

The workflow builds macOS (Apple Silicon) and Windows and attaches these
fixed-name assets to the tag's release:

| Platform                | Asset                      |
| ----------------------- | -------------------------- |
| macOS · Apple Silicon   | `AgentMaster-macOS-arm64.dmg`    |
| Windows · x64           | `AgentMaster-Windows-Setup.exe`  |

The fixed names (set in [`electron-builder.yml`](electron-builder.yml)) are what make
the site's `releases/latest/download/<name>` links stable across versions. The site
also reads the GitHub Releases API to show the live version, date, and download size.

> The release itself must be a **full release, not a prerelease** — the site's
> download buttons and the app's in-app update check both use GitHub's
> `releases/latest` API, which skips prereleases.

## macOS signing and notarization

The workflow supports two modes and picks one automatically based on whether the
signing secrets exist. **No workflow or config edit is needed to switch.**

**Current mode — unsigned.** Without the secrets, electron-builder skips signing,
then skips notarization ("app is not signed"), and `scripts/afterPack.cjs` ad-hoc
signs so the app can launch on Apple Silicon at all. Downloaded copies are
quarantined and unnotarized, so macOS reports **"Agent Master is damaged and can't be
opened"** and the user must run:

```bash
xattr -dr com.apple.quarantine "/Applications/Agent Master.app"
```

Right-click → Open does *not* clear that error — it only dismisses the milder
"unidentified developer" dialog. Windows shows a comparable one-time SmartScreen
prompt (**More info → Run anyway**), which needs an EV cert to remove and is out
of scope here.

**Target mode — signed + notarized.** Add the five repository secrets below
(Settings → Secrets and variables → Actions) and the next tag produces a build
Gatekeeper accepts with no terminal step.

| Secret | What it is |
| --- | --- |
| `MAC_CERT_P12` | Developer ID Application cert + private key, exported as `.p12`, base64-encoded |
| `MAC_CERT_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_ID` | Apple ID email of the Developer Program account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from appleid.apple.com — **not** the account password |
| `APPLE_TEAM_ID` | 10-character Team ID from the Apple Developer membership page |

Producing `MAC_CERT_P12`, on a Mac:

1. Enrol in the Apple Developer Program ($99/year). Enrolment approval can take
   anywhere from hours to a couple of days.
2. In Xcode (Settings → Accounts → Manage Certificates) or on
   developer.apple.com, create a **Developer ID Application** certificate. This is
   the only kind Gatekeeper accepts for software distributed outside the App
   Store — "Apple Development" and "Mac App Distribution" certs will not work.
3. In Keychain Access, find the cert, expand it to confirm the private key is
   attached, right-click → Export as `.p12`, and set a password.
4. Base64 it and copy to the clipboard:
   ```bash
   base64 -i AgentMaster-DeveloperID.p12 | pbcopy
   ```
   Paste that as `MAC_CERT_P12`; the export password becomes `MAC_CERT_PASSWORD`.

Notes:

- Notarization is a round-trip to Apple and typically adds **5–15 minutes** to the
  macOS job, occasionally much longer when their service is backed up. It is not a
  hang; check the job log for the `notarytool` submission id before assuming it is.
- Entitlements live in `build/entitlements.mac.plist` (and `.inherit.plist` for the
  helper apps). They are the standard Electron set — JIT, unsigned executable
  memory, dyld env vars — plus `disable-library-validation`, which the prebuilt
  `node-pty` native module needs. Dropping any of them tends to surface as the app
  launching to a blank window rather than as a build failure.
- To verify a produced build, on a Mac:
  ```bash
  spctl -a -vvv -t install "/Applications/Agent Master.app"   # expect: accepted, source=Notarized Developer ID
  xcrun stapler validate "/Applications/Agent Master.app"     # expect: The validate action worked!
  ```
- Certificates expire after 5 years, and the notarization service rejects builds
  signed with an expired one. Renewal means repeating the export above.

## Updating the download site

The site is the `gh-pages` branch of this repo (single static `index.html` +
assets). Edit, commit, push — GitHub Pages redeploys automatically.
