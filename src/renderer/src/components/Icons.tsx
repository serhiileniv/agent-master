import type { ReactNode } from 'react'

/**
 * The icon set.
 *
 * These used to be Feather/Lucide geometry transcribed by hand — round caps,
 * round joins, rounded rectangles. Redrawing the usual shapes does not make
 * them yours; they still read as the generic outline pack, and an icon that
 * could sit on any other product unchanged is not iconography.
 *
 * So the set has three house rules, and every glyph below follows them:
 *
 * 1. BUTT CAPS, MITRE JOINS. An engraved line is cut, not drawn with a round
 *    nib — it ends square and turns sharp. This is the most visible departure
 *    from the pack look and it survives all the way down to 14px.
 *
 * 2. ONE CHAMFERED CORNER, always bottom-right, always 3 units. It marks the
 *    icon's ENCLOSING form — not every shape inside it — so a composition made
 *    of parts (the grid, the columns) gets a single chamfer at the composition's
 *    own bottom-right. This is the icon-scale relative of the seam: the cut that
 *    says a thing is sealed. Bottom-right rather than top-left because tabs,
 *    prompts and detail almost always live top-left, and the two would collide.
 *
 * 3. SQUARE NODES. Anywhere the set needs a point — branch commits, slider
 *    handles — it is a square, never a circle. A node is a cell.
 *
 * Stroke is 1.5 on a 24 grid with shapes inset to 3, so at 16px render the
 * strokes land close to whole pixels instead of straddling two.
 *
 * The one deliberate exception is IconCommand: ⌘ is a letterform the OS itself
 * uses, not an icon, and redrawing it in a house style would make it stop
 * meaning what it means.
 */
function Svg({ children, size = 19 }: { children: ReactNode; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="butt"
      strokeLinejoin="miter"
    >
      {children}
    </svg>
  )
}

/** Tab top-left, chamfer bottom-right. */
const FOLDER_PATH = 'M3 8V4.5h6L11 8h10v8.5L17.5 20H3z'

export const IconFolder = (): JSX.Element => (
  <Svg>
    <path d={FOLDER_PATH} />
  </Svg>
)

/** Folder glyph sized like the header/rail buttons (IconFolder is fixed 19px). */
export const IconFiles = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d={FOLDER_PATH} />
  </Svg>
)

/**
 * Open folder: the back plate stays put and the front plate tilts away from it.
 * The tilted plate's bottom-right is already a cut edge, so it carries the
 * chamfer rule implicitly rather than adding a second one.
 */
const FOLDER_OPEN_BACK = 'M3 8V4.5h6L11 8h10v3'
const FOLDER_OPEN_FRONT = 'M6 11h15.5l-3 9.5H3z'

export const IconFolderOpen = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d={FOLDER_OPEN_BACK} />
    <path d={FOLDER_OPEN_FRONT} />
  </Svg>
)

/**
 * FILE-TYPE GLYPHS.
 *
 * One page silhouette — chamfered bottom-right like every other enclosing form
 * in the set — carrying a different mark per family. The mark is deliberately
 * simple: at the 14px these render at, colour is what tells `.ts` from `.json`
 * in peripheral vision, and a busier mark would only turn to mush. See
 * fileIcons.ts for which extension resolves to which of these.
 */
const PAGE_PATH = 'M5.5 3.5h13v13.5L15 20.5H5.5z'

const Page = ({ size, children }: { size: number; children?: ReactNode }): JSX.Element => (
  <Svg size={size}>
    <path d={PAGE_PATH} />
    {children}
  </Svg>
)

/** Plain page — the fallback for anything unmapped. */
export const IconFilePage = ({ size = 14 }: { size?: number }): JSX.Element => <Page size={size} />

/** Source code: chevrons. */
export const IconFileCode = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M10 10.5L7.5 13l2.5 2.5M14 10.5L16.5 13 14 15.5" />
  </Page>
)

/** Structured data and config: square braces, because a curved brace would be
 *  the only round join in the set. */
export const IconFileBraces = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M10.5 10H9v2.5H7.75v1H9V16h1.5M13.5 10H15v2.5h1.25v1H15V16h-1.5" />
  </Page>
)

/** Prose: ruled lines, the last one short. */
export const IconFileText = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M8.5 10h7M8.5 12.75h7M8.5 15.5h4" />
  </Page>
)

/** Image: a framed square with a horizon. */
export const IconFileImage = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M8 10h8v6H8z" />
    <path d="M8 14.5l2.5-2 2 1.5L14 12.5l2 2" />
  </Page>
)

/** Lock files: a padlock with a square shackle — a node is a cell. */
export const IconFileLock = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M10 12.5V10.5h4v2" />
    <path d="M8.5 12.5h7V17h-7z" />
  </Page>
)

/** Archives: the strip down a zipper. */
export const IconFileArchive = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M12 8v1.5M12 11v1.5M12 14v1.5" />
    <path d="M10.5 17h3v2.5h-3z" />
  </Page>
)

/** Shell scripts: a prompt. */
export const IconFileTerminal = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Page size={size}>
    <path d="M8.5 11l2 2-2 2M12.5 15h3.5" />
  </Page>
)

/** Header action: new file. */
export const IconNewFile = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M5.5 3.5h9v10.5L11 17.5H5.5z" />
    <path d="M17 15.5v6M14 18.5h6" />
  </Svg>
)

/** Header action: new folder. */
export const IconNewFolder = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M3 8V4.5h6L11 8h7v5.5" />
    <path d="M3 8v10h9" />
    <path d="M17 14.5v6M14 17.5h6" />
  </Svg>
)

export const IconPlus = (): JSX.Element => (
  <Svg>
    <path d="M12 4.5v15M4.5 12h15" />
  </Svg>
)

/* Four cells; the chamfer belongs to the composition, so only the bottom-right
   cell carries it. */
export const IconGrid = (): JSX.Element => (
  <Svg>
    <path d="M3.5 3.5h7v7h-7z" />
    <path d="M13.5 3.5h7v7h-7z" />
    <path d="M3.5 13.5h7v7h-7z" />
    <path d="M13.5 13.5h7v4.5L18 20.5h-4.5z" />
  </Svg>
)

export const IconColumns = (): JSX.Element => (
  <Svg>
    <path d="M3.5 3.5h6v17h-6z" />
    <path d="M14.5 3.5h6v13.5L17 20.5h-2.5z" />
  </Svg>
)

export const IconTerminal = (): JSX.Element => (
  <Svg>
    <path d="M3 4.5h18v11L17.5 19.5H3z" />
    <path d="M6.5 9l2.5 2.5-2.5 2.5M12 14h5" />
  </Svg>
)

/* Commits are squares, not circles — a node is a cell. */
export const IconBranch = (): JSX.Element => (
  <Svg>
    <path d="M5 4.5h3.5V8H5zM5 16h3.5v3.5H5zM15.5 6.5H19V10h-3.5z" />
    <path d="M6.75 8v8M17.25 10c0 3.5-4.5 4.25-8.5 5.5" />
  </Svg>
)

export const IconFit = (): JSX.Element => (
  <Svg>
    <path d="M3.5 9V3.5H9M20.5 9V3.5H15M3.5 15v5.5H9M20.5 15v5.5H15" />
  </Svg>
)

/* A gear, because it reads faster than anything else — but drawn to the house
   rules rather than transcribed. Eight teeth on a strict 45° division with flat
   tips and hard mitred flanks, where the pack version is a twelve-tooth cog
   with rounded everything. The hub is a square: a node is a cell. */
export const IconSettings = (): JSX.Element => (
  <Svg>
    <path d="M9.21 5.26L10.15 2.48L13.85 2.48L14.79 5.26L17.42 3.96L20.04 6.58L18.74 9.21L21.52 10.15L21.52 13.85L18.74 14.79L20.04 17.42L17.42 20.04L14.79 18.74L13.85 21.52L10.15 21.52L9.21 18.74L6.58 20.04L3.96 17.42L5.26 14.79L2.48 13.85L2.48 10.15L5.26 9.21L3.96 6.58L6.58 3.96L9.21 5.26Z" />
    <path d="M9.6 9.6h4.8v4.8H9.6z" />
  </Svg>
)

export const IconClose = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const IconRefresh = ({ size = 15 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" />
    <path d="M20 3.5V8.5h-5" />
  </Svg>
)

/** Card-width toggle: arrows pushing outward → "make this card wider". */
export const IconWide = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M3.5 12h17" />
    <path d="M7 8.5L3.5 12 7 15.5" />
    <path d="M17 8.5l3.5 3.5-3.5 3.5" />
  </Svg>
)

/** Card-width toggle: arrows pulling inward → "back to normal width". */
export const IconNarrow = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M3.5 12H10M20.5 12H14" />
    <path d="M6.5 8.5L10 12l-3.5 3.5" />
    <path d="M17.5 8.5L14 12l3.5 3.5" />
  </Svg>
)

export const IconSend = ({ size = 14 }: { size?: number }): JSX.Element => (
  <Svg size={size}>
    <path d="M20.5 3.5L4 10.5l6 2.5 2.5 6z" />
    <path d="M10 13L20.5 3.5" />
  </Svg>
)

/**
 * Command-palette glyph. Deliberately outside the house rules: ⌘ is a
 * letterform the OS itself uses, and squaring its loops would stop it meaning
 * what it means.
 */
export const IconCommand = (): JSX.Element => (
  <Svg>
    <path
      d="M17.5 3.5a3 3 0 0 0-3 3v11a3 3 0 1 0 3-3h-11a3 3 0 1 0 3 3v-11a3 3 0 1 0-3 3h11a3 3 0 1 0-3-3z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </Svg>
)

export const IconBell = (): JSX.Element => (
  <Svg>
    <path d="M6 9.5a6 6 0 0 1 12 0V15l2 3.5H4L6 15z" />
    <path d="M10 18.5v.5a2 2 0 0 0 4 0v-.5" />
  </Svg>
)
