import { Component, type ErrorInfo, type ReactNode } from "react";

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
    console.error("[lockstep-renderer]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
          <section className="prism-section max-w-lg">
            <h1 className="text-lg font-semibold tracking-tight">Lockstep hit a renderer error</h1>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
              {this.state.error.message}
            </p>
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
              If this mentions a missing module, run{" "}
              <code className="font-mono text-xs">pnpm install</code> from the repo root and restart
              Lockstep.
            </p>
          </section>
        </div>
      );
    }

    return this.props.children;
  }
}
