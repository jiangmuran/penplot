import * as React from 'react'

/**
 * Generic error boundary. Shell widgets are wrapped individually so a bug in one (status pill,
 * mini-player, a feature's toolbar item…) can never take down the rest of the chrome or the E-stop.
 *
 *   <SafeBoundary name="status-pill"><MachineStatusPill/></SafeBoundary>
 */
export class SafeBoundary extends React.Component<
  { name: string; fallback?: React.ReactNode | ((err: Error, reset: () => void) => React.ReactNode); resetKey?: unknown; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.name}] crashed`, error, info.componentStack)
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }
  reset = () => this.setState({ error: null })
  render() {
    if (this.state.error) {
      const f = this.props.fallback
      return typeof f === 'function' ? f(this.state.error, this.reset) : (f ?? null)
    }
    return this.props.children
  }
}
