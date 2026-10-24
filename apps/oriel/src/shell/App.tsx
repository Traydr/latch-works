import { useEffect, useRef } from "react";

import { MODE_IDS, type ModeId, type OrielBridge } from "../shared/shell";
import { MODE_ROOTS } from "./modes";
import { ModeProvider, ShellProvider, useShell } from "./shell";
import { ThemeProvider } from "./theme";
import { WelcomeGate } from "./Welcome";

export function App({ bridge }: { bridge: OrielBridge }) {
  return (
    <ThemeProvider>
      <ShellProvider bridge={bridge}>
        <Modes />
        <WelcomeGate />
      </ShellProvider>
    </ThemeProvider>
  );
}

/**
 * Every mode opened so far. The one showing is visible; the rest stay mounted, hidden and inert,
 * so their state and their subscriptions carry on (a scan, a push or a job keeps reporting). A
 * hidden mode's window-level keys and drops are off (`useModeActive`), and its media is paused.
 */
function Modes() {
  const { mode, opened } = useShell();

  return (
    <div className="h-full">
      {MODE_IDS.map((id) =>
        opened.has(id) ? <ModeFrame key={id} id={id} active={id === mode} /> : null,
      )}
    </div>
  );
}

function ModeFrame({ id, active }: { id: ModeId; active: boolean }) {
  const Root = MODE_ROOTS[id];
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) {
      for (const media of frame.current?.querySelectorAll("video, audio") ?? []) {
        if (media instanceof HTMLMediaElement) {
          media.pause();
        }
      }
    }
  }, [active]);

  return (
    <div ref={frame} className="h-full" hidden={!active} inert={!active} data-mode-frame={id}>
      <ModeProvider value={{ id, active }}>
        <Root />
      </ModeProvider>
    </div>
  );
}
