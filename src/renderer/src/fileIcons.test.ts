import { describe, it, expect } from 'vitest'
import { fileIcon, folderIcon, DEFAULT_FILE_ICON } from './fileIcons'

// The tree used to be text-only. These mappings are what let you tell a
// TypeScript file from a lock file without reading either name, so a silent
// regression here is a regression in how readable the panel is.

describe('fileIcon', () => {
  it('maps the source languages to code glyphs with distinct tones', () => {
    expect(fileIcon('index.ts')).toEqual({ glyph: 'code', tone: 'ts' })
    expect(fileIcon('App.tsx')).toEqual({ glyph: 'code', tone: 'ts' })
    expect(fileIcon('setup.js')).toEqual({ glyph: 'code', tone: 'js' })
    expect(fileIcon('main.py')).toEqual({ glyph: 'code', tone: 'python' })
    expect(fileIcon('lib.rs')).toEqual({ glyph: 'code', tone: 'rust' })
  })

  it('maps data, style, prose, image and archive families', () => {
    expect(fileIcon('data.json').glyph).toBe('braces')
    expect(fileIcon('styles.css')).toEqual({ glyph: 'code', tone: 'style' })
    expect(fileIcon('README.md')).toEqual({ glyph: 'text', tone: 'doc' })
    expect(fileIcon('logo.png')).toEqual({ glyph: 'image', tone: 'image' })
    expect(fileIcon('bundle.zip')).toEqual({ glyph: 'archive', tone: 'archive' })
    expect(fileIcon('build.sh')).toEqual({ glyph: 'terminal', tone: 'shell' })
  })

  it('falls back to a plain page for anything unmapped', () => {
    expect(fileIcon('mystery.qqq')).toEqual(DEFAULT_FILE_ICON)
    expect(fileIcon('noextension')).toEqual(DEFAULT_FILE_ICON)
    expect(fileIcon('')).toEqual(DEFAULT_FILE_ICON)
  })

  // VS Code's precedence: an exact filename beats an extension. A manifest is
  // not just "some JSON", and a lock file is not a thing you meant to edit.
  it('prefers an exact filename match over the extension', () => {
    expect(fileIcon('package.json')).toEqual({ glyph: 'braces', tone: 'manifest' })
    expect(fileIcon('package-lock.json')).toEqual({ glyph: 'lock', tone: 'lock' })
    expect(fileIcon('pnpm-lock.yaml')).toEqual({ glyph: 'lock', tone: 'lock' })
    // …and the extension still resolves for everything else with that suffix.
    expect(fileIcon('other.yaml')).toEqual({ glyph: 'braces', tone: 'config' })
  })

  // A dot at index 0 is part of the name, not an extension separator.
  it('resolves dotfiles by name rather than treating the dot as an extension', () => {
    expect(fileIcon('.gitignore')).toEqual({ glyph: 'braces', tone: 'config' })
    expect(fileIcon('.env')).toEqual({ glyph: 'braces', tone: 'config' })
    expect(fileIcon('.unknownrc')).toEqual(DEFAULT_FILE_ICON)
  })

  it('takes the last extension of a multi-dot name', () => {
    expect(fileIcon('lib.d.ts')).toEqual({ glyph: 'code', tone: 'ts' })
    expect(fileIcon('vite.config.ts')).toEqual({ glyph: 'code', tone: 'ts' })
  })

  it('is case-insensitive, so README.md and readme.md read alike', () => {
    expect(fileIcon('README.MD')).toEqual(fileIcon('readme.md'))
    expect(fileIcon('Index.TS')).toEqual(fileIcon('index.ts'))
    expect(fileIcon('PACKAGE.JSON')).toEqual(fileIcon('package.json'))
  })
})

describe('folderIcon', () => {
  it('changes with the expanded state', () => {
    expect(folderIcon(false)).toBe('folder')
    expect(folderIcon(true)).toBe('folder-open')
  })
})
