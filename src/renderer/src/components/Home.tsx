import { useStore } from '../store'
import { openProjectInteractive, openProjectByPath } from '../openProject'
import { emblemStyle } from '../projectColor'

/** First letter/number of a name → the card emblem. */
function initial(name: string): string {
  const m = name.match(/[a-z0-9]/i)
  return (m ? m[0] : name.charAt(0) || '?').toUpperCase()
}

/** Compact tail of a path (last two segments), with forward slashes. */
function prettyPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.slice(-2).join('/') || p
}

/**
 * The app's home / empty state — shown whenever no project is open (including
 * right after closing one). A hero + a grid of recent projects to jump straight
 * back in, instead of a bare "open" card.
 */
export default function Home(): JSX.Element {
  const workspaces = useStore((s) => s.workspaces)
  const noAgents = useStore((s) => s.agentClisLoaded && s.agentClis.length === 0)
  return (
    <div className="home">
      <div className="home__hero">
        {/* The handwritten wordmark IS the title — masked rather than an <img>
            so it inherits the sheen gradient and follows the theme colour. The
            text stays for screen readers and window/page titles. */}
        <h1 className="home__wordmark">
          <span className="sr-only">Spy Master</span>
        </h1>
        <p className="home__tag">
          Run your AI coding agents in parallel.
        </p>
        <button className="home__open" onClick={openProjectInteractive}>
          Open folder…
        </button>
        {noAgents && (
          <p className="home__hint">
            No agent CLIs detected yet. Install an agent CLI:{' '}
            <button
              className="home__hint-link"
              onClick={() => void window.api.openExternal('https://docs.claude.com/en/docs/claude-code/overview')}
            >
              Claude Code
            </button>
            , Codex, Gemini, Aider, Cursor, opencode or Qwen, and it’ll show up here
            automatically. You can still open a plain terminal in the meantime.
          </p>
        )}
      </div>

      {workspaces.length > 0 && (
        <div className="home__recents">
          <div className="home__recents-head">Recent projects</div>
          <div className="home__grid">
            {workspaces.map((w, i) => (
              <button
                key={w.path}
                className="home__card"
                style={{ animationDelay: `${120 + i * 55}ms` }}
                onClick={() => void openProjectByPath(w)}
                title={w.path}
              >
                <span className="home__card-emblem" style={emblemStyle(w.path)}>
                  {initial(w.name)}
                </span>
                <span className="home__card-text">
                  <span className="home__card-name">{w.name}</span>
                  <span className="home__card-path">{prettyPath(w.path)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
