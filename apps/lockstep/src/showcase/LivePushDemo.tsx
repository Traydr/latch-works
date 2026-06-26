import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { LayoutProvider, useLayoutVariant } from "../renderer/layouts/LayoutContext";
import { LayoutRenderer } from "../renderer/layouts/LayoutRenderer";
import type { LayoutContentProps } from "../renderer/layouts/types";
import type { LayoutVariant } from "../renderer/layouts/types";
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

function ShowcaseRecordCycle() {
  const { setVariant } = useLayoutVariant();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get("record") !== "1") {
      return;
    }

    startedRef.current = true;
    setVariant(1);
    let current: LayoutVariant = 1;

    const interval = window.setInterval(() => {
      if (current >= 5) {
        window.clearInterval(interval);
        return;
      }
      current = (current + 1) as LayoutVariant;
      setVariant(current);
    }, 6000);

    return () => window.clearInterval(interval);
  }, [setVariant]);

  return null;
}

function ShowcaseLivePushInner() {
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("Waiting to start push...");
  const [runProgress, setRunProgress] = useState<RunProgressState>(emptyRunProgress);
  const [logs, setLogs] = useState<string[]>([]);
  const [screen, setScreen] = useState<LayoutContentProps["screen"]>("run");
  const eventCursorRef = useRef(0);
  const pushStartedRef = useRef(false);

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
    if (pushStartedRef.current) {
      return;
    }
    pushStartedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const delayMs = params.get("record") === "1" ? 2500 : 0;

    const startTimeout = window.setTimeout(() => {
      eventCursorRef.current = 0;
      setRunning(true);
      setRunProgress(emptyRunProgress());
      setRunLabel("Starting live push...");
      setLogs(["Starting live push of demo archive..."]);

      void fetch("/api/demo/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRoot: "/tmp/lockstep-demo-archive" }),
      });
    }, delayMs);

    let poll = 0;
    const pollTimeout = window.setTimeout(() => {
      poll = window.setInterval(() => {
        void fetch(`/api/demo/push/events?since=${eventCursorRef.current}`)
          .then((response) => response.json())
          .then((payload: { events: LockstepRunEvent[]; total: number }) => {
            for (const event of payload.events) {
              handleEvent(event);
            }
            eventCursorRef.current = payload.total;
          })
          .catch(() => undefined);
      }, 250);
    }, delayMs);

    return () => {
      window.clearTimeout(startTimeout);
      window.clearTimeout(pollTimeout);
      window.clearInterval(poll);
    };
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
    <>
      <ShowcaseRecordCycle />
      <LayoutRenderer {...layoutProps} />
    </>
  );
}

export function ShowcaseLivePushDemo() {
  return (
    <LayoutProvider>
      <ShowcaseLivePushInner />
    </LayoutProvider>
  );
}
