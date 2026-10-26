// Render crash guard for the analytic canvas region. A throw during paint
// (poisoned field, WebGL failure) shows an inline fallback instead of
// white-screening the whole app. resetKey clears the boundary on new input.

import { Component, type ReactNode } from "react";

interface Props {
  resetKey: string;
  label: string;
  children: ReactNode;
}

interface State {
  error: string | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown): void {
    console.error(`ErrorBoundary (${this.props.label}) caught:`, err instanceof Error ? err.message : String(err));
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="errorFallback" role="alert">
          <p className="errorTitle">Render failed ({this.props.label}), showing controls.</p>
          <p className="errorDetail mono">{this.state.error}</p>
          <button type="button" className="retryButton" onClick={this.handleRetry}>
            Retry render
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
