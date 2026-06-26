import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LayoutProvider } from "../renderer/layouts/LayoutContext";
import { LayoutRenderer } from "../renderer/layouts/LayoutRenderer";
import type { LayoutContentProps } from "../renderer/layouts/types";
import type { LockstepRunEvent } from "../shared/types";
import {
  applyRunEvent,
  emptyRunProgress,
  type RunProgressState,
} from "../renderer/utils/runProgress";
import { showcasePlan, showcasePlanItems, showcaseSettings } from "./screens";

const noop = () => undefined;

const baseProps: Omit<
  LayoutContentProps,
  "logs" | "runLabel" | "runProgress" | "running" | "screen"
> = {
  activeProfile: showcaseSettings.profiles[0] ?? null,
  doctorResult: null,
  error: null,
  filter: "",
  filteredItems: showcasePlanItems(),
  handlers: {
    onBack: noop,
    onCancel: noop,
    onCreateProfile: noop,
    onDoctor: noop,
    onFilterChange: noop,
    onPlan: noop,
    onPrune: noop,
    onProfileChange: noop,
    onPush: noop,
    onSessionTokenChange: noop,
    onViewActivity: noop,
    onViewPlan: noop,
  },
  plan: showcasePlan,
  profileForm: {
    apiUrl: "https://archive.example.com",
    name: "",
    sourceRoot: "",
    token: "",
  },
  sessionToken: "",
  settings: showcaseSettings,
  onCancelProfile: noop,
  onPickFolder: noop,
  onProfileFormChange: noop,
  onSubmitProfile: noop,
};

export function ShowcaseLivePushDemo() {
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("Preparing live push...");
  const [runProgress, setRunProgress] = useState<RunProgressState>(emptyRunProgress);
  const [logs, setLogs] = useState<string[]>([]);
  const [screen, setScreen] = useState<LayoutContentProps["screen"]>("run");
  const startedRef = useRef(false);

  const handleEvent = useCallback((event: LockstepRunEvent | { type: "demo-end" }) => {
    if (event.type === "demo-end") {
      setRunning(false);
      return;
    }

    setRunProgress((current) => applyRunEvent(current, event));

    if (event.type === "status") {
      setRunLabel(event.message);
      setLogs((current) => [...current.slice(-200), event.message]);
    }

    if (event.type === "scan-progress") {
      const message =
        event.progress.stage === "hashing"
          ? `Hashing ${event.progress.path ?? ""}`
          : `Scanning (${event.progress.filesFound} files)`;
      setRunLabel(message);
      setLogs((current) => [...current.slice(-200), message]);
    }

    if (event.type === "item-success") {
      const message = `[${event.current}/${event.total}] ${event.action} ${event.path}`;
      setRunLabel(message);
      setLogs((current) => [...current.slice(-200), message]);
    }

    if (event.type === "item-failure") {
      const message = `[${event.current}/${event.total}] failed ${event.path}: ${event.error}`;
      setRunLabel(message);
      setLogs((current) => [...current.slice(-200), message]);
    }

    if (event.type === "complete") {
      setRunning(false);
      setRunLabel(event.summary.message ?? `${event.summary.action} ${event.summary.status}`);
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }
    startedRef.current = true;

    setRunning(true);
    setScreen("run");
    setLogs(["Starting live push of demo archive..."]);
    setRunProgress(emptyRunProgress());

    void fetch("/api/demo/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRoot: "/tmp/lockstep-demo-archive" }),
    });

    const source = new EventSource("/api/demo/push/stream");
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as LockstepRunEvent | { type: "demo-end" };
        handleEvent(event);
        if (event.type === "demo-end") {
          source.close();
        }
      } catch {
        // ignore malformed events
      }
    };

    return () => source.close();
  }, [handleEvent]);

  const layoutProps = useMemo(
    (): LayoutContentProps => ({
      ...baseProps,
      logs,
      runLabel,
      runProgress,
      running,
      screen,
      handlers: {
        ...baseProps.handlers,
        onBack: () => setScreen("dashboard"),
        onViewPlan: () => setScreen("plan"),
        onViewActivity: () => setScreen("run"),
      },
    }),
    [logs, runLabel, runProgress, running, screen],
  );

  return (
    <LayoutProvider>
      <LayoutRenderer {...layoutProps} />
    </LayoutProvider>
  );
}
