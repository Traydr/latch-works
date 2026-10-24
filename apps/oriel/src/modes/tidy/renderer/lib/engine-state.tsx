import type {
  EncoderCapabilities,
  EngineInput,
  EngineMethodName,
  EngineOutput,
  Job,
  JobId,
  Root,
  RootId,
  Settings,
} from "@latch-works/glazier-core/contract";
import { RootIdSchema } from "@latch-works/glazier-core/contract";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useModeActive } from "../../../../shell/shell";
import { call, onEngineEvent } from "./api";

interface EngineState {
  ready: boolean;
  error: string | null;
  roots: Root[];
  settings: Settings | null;
  capabilities: EncoderCapabilities | null;
  jobs: Job[];
  /** Bumps whenever the catalog changes, so queries refetch. */
  catalogVersion: number;
  rootId: RootId | null;
  selectRoot: (rootId: RootId | null) => void;
  setSettings: (settings: Settings) => Promise<void>;
  report: (cause: unknown) => void;
  dismissError: () => void;
}

const EngineContext = createContext<EngineState | null>(null);

const ROOT_KEY = "oriel.tidy.root";

/** The folder Tidy showed last, while it still tidies it, or else its first. */
function startingRoot(roots: readonly Root[]): RootId | null {
  const stored = RootIdSchema.safeParse(Number(window.localStorage.getItem(ROOT_KEY)));
  const kept = stored.success ? roots.find((root) => root.id === stored.data) : undefined;

  return kept?.id ?? roots[0]?.id ?? null;
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roots, setRoots] = useState<Root[]>([]);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [capabilities, setCapabilities] = useState<EncoderCapabilities | null>(null);
  const [jobs, setJobs] = useState<Map<JobId, Job>>(new Map());
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [rootId, setRootId] = useState<RootId | null>(null);
  const bump = useRef<number | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    const unsubscribe = onEngineEvent((event) => {
      switch (event.kind) {
        case "job":
          setJobs((current) => new Map(current).set(event.job.id, event.job));
          break;
        case "catalog-changed":
          // Batches of catalog events (a scan emits several) refetch once.
          if (bump.current === null) {
            bump.current = window.setTimeout(() => {
              bump.current = null;
              setCatalogVersion((version) => version + 1);
            }, 250);
          }

          break;
        case "roots-changed":
          setRoots(event.roots);
          break;
        case "capabilities":
          setCapabilities(event.capabilities);
          break;
        default: {
          const _exhaustive: never = event;

          return _exhaustive;
        }
      }
    });

    return unsubscribe;
  }, []);

  const active = useModeActive();
  const [attempt, setAttempt] = useState(0);

  // Until the engine answers, Tidy on screen tries again whenever the window comes back to the
  // front, such as after the owner quit the old Glazier that refused its start.
  useEffect(() => {
    if (ready || !active) {
      return;
    }

    const retry = () => setAttempt((current) => current + 1);

    window.addEventListener("focus", retry);

    return () => window.removeEventListener("focus", retry);
  }, [active, ready]);

  // The engine's state, read when Tidy shows, and again each time it shows or regains focus
  // until it has been.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` asks for another read.
  useEffect(() => {
    if (ready || !active) {
      return;
    }

    let live = true;

    call("getState", {}).then(
      (state) => {
        if (!live) {
          return;
        }

        setRoots(state.roots);
        setSettingsState(state.settings);
        setCapabilities(state.capabilities);
        setJobs(new Map(state.jobs.map((job) => [job.id, job])));
        setRootId((current) => current ?? startingRoot(state.roots));
        setReady(true);
      },
      (cause: Error) => {
        if (live) {
          setError(cause.message);
        }
      },
    );

    return () => {
      live = false;
    };
  }, [active, attempt, ready]);

  useEffect(() => {
    if (rootId !== null && !roots.some((root) => root.id === rootId)) {
      setRootId(roots[0]?.id ?? null);
    } else if (rootId === null && roots[0]) {
      setRootId(startingRoot(roots));
    }
  }, [roots, rootId]);

  // Remembered, so Tidy opens on the same folder next time.
  useEffect(() => {
    if (rootId !== null) {
      window.localStorage.setItem(ROOT_KEY, String(rootId));
    }
  }, [rootId]);

  const setSettings = useCallback(
    async (next: Settings) => {
      try {
        setSettingsState(await call("updateSettings", next));
        setCatalogVersion((version) => version + 1);
      } catch (cause) {
        report(cause);
      }
    },
    [report],
  );

  const value = useMemo<EngineState>(
    () => ({
      ready,
      error,
      roots,
      settings,
      capabilities,
      jobs: [...jobs.values()].sort((left, right) => right.startedAt - left.startedAt),
      catalogVersion,
      rootId,
      selectRoot: setRootId,
      setSettings,
      report,
      dismissError: () => setError(null),
    }),
    [
      ready,
      error,
      roots,
      settings,
      capabilities,
      jobs,
      catalogVersion,
      rootId,
      setSettings,
      report,
    ],
  );

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineState {
  const state = useContext(EngineContext);

  if (!state) {
    throw new Error("useEngine needs an EngineProvider.");
  }

  return state;
}

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Calls an engine method and keeps the result, calling again whenever the input changes or the
 * catalog does. `input` is compared by its JSON, so callers can build it inline.
 */
export function useEngineQuery<M extends EngineMethodName>(
  method: M,
  input: EngineInput<M> | null,
): QueryState<EngineOutput<M>> {
  const { catalogVersion } = useEngine();
  const [data, setData] = useState<EngineOutput<M> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  // One string names the request: its input, the catalog version and manual refreshes. Only the
  // newest request's answer is kept, so a slow older one never overwrites it.
  const request = input === null ? null : `${JSON.stringify(input)}|${catalogVersion}|${nonce}`;
  const latest = useRef<string | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    latest.current = request;
    const current = inputRef.current;

    if (request === null || current === null) {
      setData(null);

      return;
    }

    setLoading(true);

    call(method, current).then(
      (result) => {
        if (latest.current === request) {
          setData(result);
          setError(null);
          setLoading(false);
        }
      },
      (cause: Error) => {
        if (latest.current === request) {
          setError(cause.message);
          setLoading(false);
        }
      },
    );
  }, [method, request]);

  return { data, loading, error, refresh: () => setNonce((value) => value + 1) };
}

/** The newest job of a type for a root that is still going, if any. */
export function useActiveJob(type: Job["type"], rootId: RootId | null): Job | null {
  const { jobs } = useEngine();

  return (
    jobs.find(
      (job) =>
        job.type === type &&
        job.rootId === rootId &&
        (job.state === "queued" || job.state === "running" || job.state === "paused"),
    ) ?? null
  );
}
