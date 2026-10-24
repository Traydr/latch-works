import { Component, type ErrorInfo, type ReactNode } from "react";

import { EmptyState } from "../../../../ui/ui";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[oriel:sync]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <EmptyState title="Sync hit an error">
          {this.state.error.message} If it names a missing module, run <code>pnpm install</code> in
          the repository and restart Oriel.
        </EmptyState>
      );
    }

    return this.props.children;
  }
}
