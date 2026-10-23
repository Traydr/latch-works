import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Imported here rather than from the CSS so Vite emits the font files beside the bundle.
import "@fontsource-variable/geist";
import "./index.css";
import { App } from "./renderer/App";
import { ErrorBoundary } from "./renderer/components/ErrorBoundary";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      {window.glazier ? (
        <App />
      ) : (
        <p className="p-6 text-sm">
          The Glazier desktop bridge is unavailable; the preload script did not load.
        </p>
      )}
    </ErrorBoundary>
  </StrictMode>,
);
