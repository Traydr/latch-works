import { Component, type ErrorInfo, type ReactNode } from "react";

import { ModeLayout } from "../../../../shell/ModeLayout";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Keeps a renderer error inside Tidy: the mode shows it, and the switcher still works. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[oriel:tidy]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <ModeLayout>
          <div className="flex flex-1 items-center justify-center bg-zinc-50 p-6 dark:bg-zinc-950">
            <section className="lw-card max-w-lg p-5">
              <h1 className="text-lg font-semibold tracking-tight">Tidy hit a renderer error</h1>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
                {this.state.error.message}
              </p>
              <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">
                If this mentions a missing module, run{" "}
                <code className="font-mono text-xs">pnpm install</code> from the repo root and
                restart Oriel.
              </p>
            </section>
          </div>
        </ModeLayout>
      );
    }

    return this.props.children;
  }
}
