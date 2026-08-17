/**
 * Which icon a file row gets, and what colour it is tinted.
 *
 * VS Code's tree is scannable because of COLOUR, not because of glyph detail —
 * at 14px you recognise a `.ts` file as a blue mark in peripheral vision and
 * only read the shape if you're actually looking. So this maps a filename to a
 * silhouette from the app's own icon set plus a colour class, rather than
 * vendoring Seti or Material: both are MIT and could be shipped, but they are
 * filled, multi-colour and largely brand logos, and would sit visibly apart
 * from every other icon in the app.
 *
 * Around 20 mappings, not the ~240 of Seti or the ~1,400 of Material. The
 * fallback is a plain page in the default text colour, which is what the tree
 * showed for everything before this.
 *
 * Precedence matches VS Code: an exact filename match beats an extension match.
 * That is why `package.json` reads as a lock/manifest rather than as generic
 * JSON, and why `.gitignore` — which has no extension at all — resolves.
 */

/** The silhouette drawn for a row. Each maps to one glyph in Icons.tsx. */
export type IconGlyph =
  | 'code'
  | 'braces'
  | 'text'
  | 'image'
  | 'lock'
  | 'archive'
  | 'terminal'
  | 'page'

/** Glyph + colour class for one row. `tone` becomes `filetree__icon--<tone>`;
 *  the colours themselves live in styles.css so themes control them. */
export interface FileIcon {
  glyph: IconGlyph
  tone: string
}

const CODE = (tone: string): FileIcon => ({ glyph: 'code', tone })
const DATA = (tone: string): FileIcon => ({ glyph: 'braces', tone })

/** Exact filenames. Checked first — a manifest is not just "some JSON". */
const BY_NAME: Record<string, FileIcon> = {
  'package.json': DATA('manifest'),
  'package-lock.json': { glyph: 'lock', tone: 'lock' },
  'yarn.lock': { glyph: 'lock', tone: 'lock' },
  'pnpm-lock.yaml': { glyph: 'lock', tone: 'lock' },
  'bun.lockb': { glyph: 'lock', tone: 'lock' },
  'bun.lock': { glyph: 'lock', tone: 'lock' },
  'cargo.lock': { glyph: 'lock', tone: 'lock' },
  'tsconfig.json': DATA('config'),
  'dockerfile': { glyph: 'terminal', tone: 'config' },
  'makefile': { glyph: 'terminal', tone: 'config' },
  '.gitignore': DATA('config'),
  '.gitattributes': DATA('config'),
  '.npmrc': DATA('config'),
  '.editorconfig': DATA('config'),
  '.env': DATA('config'),
  'license': { glyph: 'text', tone: 'doc' },
  'readme.md': { glyph: 'text', tone: 'doc' }
}

/** Extensions, lowercased, without the dot. */
const BY_EXT: Record<string, FileIcon> = {
  ts: CODE('ts'),
  tsx: CODE('ts'),
  mts: CODE('ts'),
  cts: CODE('ts'),
  js: CODE('js'),
  jsx: CODE('js'),
  mjs: CODE('js'),
  cjs: CODE('js'),
  json: DATA('manifest'),
  jsonc: DATA('manifest'),
  json5: DATA('manifest'),
  yml: DATA('config'),
  yaml: DATA('config'),
  toml: DATA('config'),
  ini: DATA('config'),
  conf: DATA('config'),
  cfg: DATA('config'),
  env: DATA('config'),
  css: CODE('style'),
  scss: CODE('style'),
  sass: CODE('style'),
  less: CODE('style'),
  styl: CODE('style'),
  html: CODE('markup'),
  htm: CODE('markup'),
  xml: CODE('markup'),
  vue: CODE('markup'),
  svelte: CODE('markup'),
  md: { glyph: 'text', tone: 'doc' },
  mdx: { glyph: 'text', tone: 'doc' },
  markdown: { glyph: 'text', tone: 'doc' },
  txt: { glyph: 'text', tone: 'doc' },
  rst: { glyph: 'text', tone: 'doc' },
  png: { glyph: 'image', tone: 'image' },
  jpg: { glyph: 'image', tone: 'image' },
  jpeg: { glyph: 'image', tone: 'image' },
  gif: { glyph: 'image', tone: 'image' },
  webp: { glyph: 'image', tone: 'image' },
  bmp: { glyph: 'image', tone: 'image' },
  svg: { glyph: 'image', tone: 'image' },
  ico: { glyph: 'image', tone: 'image' },
  avif: { glyph: 'image', tone: 'image' },
  sh: { glyph: 'terminal', tone: 'shell' },
  bash: { glyph: 'terminal', tone: 'shell' },
  zsh: { glyph: 'terminal', tone: 'shell' },
  fish: { glyph: 'terminal', tone: 'shell' },
  py: CODE('python'),
  rs: CODE('rust'),
  go: CODE('go'),
  rb: CODE('ruby'),
  java: CODE('java'),
  php: CODE('php'),
  c: CODE('clang'),
  h: CODE('clang'),
  cpp: CODE('clang'),
  hpp: CODE('clang'),
  sql: DATA('data'),
  zip: { glyph: 'archive', tone: 'archive' },
  tar: { glyph: 'archive', tone: 'archive' },
  gz: { glyph: 'archive', tone: 'archive' },
  tgz: { glyph: 'archive', tone: 'archive' },
  rar: { glyph: 'archive', tone: 'archive' },
  '7z': { glyph: 'archive', tone: 'archive' }
}

/** What an unmapped file gets: a plain page, no tint. */
export const DEFAULT_FILE_ICON: FileIcon = { glyph: 'page', tone: 'default' }

/**
 * Resolve a filename to its icon. Exact-name match first, then extension, then
 * the plain page. Matching is case-insensitive — `README.md` and `readme.md`
 * must not read as different kinds of thing.
 */
export function fileIcon(name: string): FileIcon {
  if (typeof name !== 'string' || !name) return DEFAULT_FILE_ICON
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName) return byName
  // `lib.d.ts` should resolve on `ts`, so take the LAST segment. A leading dot
  // is part of the name (`.env`), not an extension — those are in BY_NAME.
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return DEFAULT_FILE_ICON
  return BY_EXT[lower.slice(dot + 1)] ?? DEFAULT_FILE_ICON
}

/** Folders get one silhouette in two states. Seti — VS Code's built-in default
 *  — ships no folder icons at all, which is why stock VS Code shows only a
 *  twisty; this follows Material's behaviour instead. */
export function folderIcon(expanded: boolean): 'folder-open' | 'folder' {
  return expanded ? 'folder-open' : 'folder'
}
