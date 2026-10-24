import { Activity } from "react";

import { MODE_IDS, type OrielBridge } from "../shared/shell";
import { MODE_ROOTS } from "./modes";
import { ShellProvider, useShell } from "./shell";
import { ThemeProvider } from "./theme";

export function App({ bridge }: { bridge: OrielBridge }) {
  return (
    <ThemeProvider>
      <ShellProvider bridge={bridge}>
        <Modes />
      </ShellProvider>
    </ThemeProvider>
  );
}

/**
 * Every mode opened so far, the one showing visible and the rest hidden with their state kept:
 * a hidden mode keeps what it rendered and its state, and its effects stop until it shows again.
 */
function Modes() {
  const { mode, opened } = useShell();

  return (
    <div className="h-full">
      {MODE_IDS.map((id) => {
        const Root = MODE_ROOTS[id];

        return opened.has(id) ? (
          <Activity key={id} mode={id === mode ? "visible" : "hidden"}>
            <Root />
          </Activity>
        ) : null;
      })}
    </div>
  );
}
