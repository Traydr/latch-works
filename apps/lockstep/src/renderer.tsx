import React from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./renderer/App";
import { BridgeUnavailable } from "./renderer/components/BridgeUnavailable";
import { ErrorBoundary } from "./renderer/components/ErrorBoundary";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {typeof window.lockstep === "undefined" ? <BridgeUnavailable /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
