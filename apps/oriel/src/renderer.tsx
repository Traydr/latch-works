import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./shell/App";
import { ErrorBoundary } from "./shell/ErrorBoundary";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      {window.oriel ? (
        <App bridge={window.oriel} />
      ) : (
        <p className="p-6 text-sm">
          The Oriel desktop bridge is unavailable; the preload script did not load.
        </p>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
