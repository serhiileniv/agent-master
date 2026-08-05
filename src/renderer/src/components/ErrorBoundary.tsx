import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

/**
 * Last line of defence in the renderer: a single component throwing during render
 * would otherwise unmount the whole tree to a blank window with no way back. This
 * catches it and offers a reload instead.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[spymaster] renderer crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash">
        <div className="crash__card">
          <h1 className="crash__title">Something went wrong</h1>
          <p className="crash__msg">
            Spy Master hit an unexpected error. Your open terminals were interrupted, but your
            saved workspace is safe. Reloading usually fixes it.
          </p>
          <pre className="crash__detail">{this.state.error.message}</pre>
          <button className="crash__btn" onClick={() => window.location.reload()}>
            Reload Spy Master
          </button>
        </div>
      </div>
    )
  }
}
