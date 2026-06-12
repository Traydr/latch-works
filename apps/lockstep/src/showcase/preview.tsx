import React from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { ShowcasePlanScreen, ShowcasePushScreen } from "./screens";

document.documentElement.classList.add("dark");
document.body.classList.add("dark", "bg-zinc-950");

const screen = new URLSearchParams(window.location.search).get("screen") ?? "plan";
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <React.StrictMode>
    {screen === "push" ? <ShowcasePushScreen /> : <ShowcasePlanScreen />}
  </React.StrictMode>,
);
