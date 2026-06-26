import React from "react";
import { createRoot } from "react-dom/client";

import "../index.css";
import { ShowcaseLivePushDemo } from "./LivePushDemo";
import { ShowcaseFrame } from "./ShowcaseFrame";
import { ShowcaseLayoutDemo, ShowcasePlanScreen, ShowcasePushScreen } from "./screens";

document.documentElement.classList.add("dark");
document.body.classList.add("dark", "bg-zinc-950");

const screen = new URLSearchParams(window.location.search).get("screen") ?? "live";
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

function wrap(content: React.ReactNode) {
  return <ShowcaseFrame>{content}</ShowcaseFrame>;
}

const content =
  screen === "plan" ? (
    wrap(<ShowcasePlanScreen />)
  ) : screen === "push" ? (
    wrap(<ShowcasePushScreen />)
  ) : screen === "mock" ? (
    wrap(<ShowcaseLayoutDemo />)
  ) : (
    wrap(<ShowcaseLivePushDemo />)
  );

createRoot(rootElement).render(content);
