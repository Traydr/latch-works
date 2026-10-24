import { Check, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";

import frameViewIcon from "../../media/modes/frame-view-icon.svg";
import glazierIcon from "../../media/modes/glazier-icon.svg";
import lockstepIcon from "../../media/modes/lockstep-icon.svg";
import orielIcon from "../../media/oriel-icon.svg";
import type { FirstRun } from "../shared/shell";
import { Switch } from "../ui/ui";
import { baseName } from "./paths";
import { useShell } from "./shell";

/** The three modes' glyphs, which gather into Oriel's mark: from the left, the middle, the right. */
const GLYPHS = [
  { src: glazierIcon, from: "left" },
  { src: frameViewIcon, from: "middle" },
  { src: lockstepIcon, from: "right" },
] as const;

/** The mode glyphs moving together and giving way to the app's mark. */
function Assembly() {
  return (
    <div className="relative mx-auto size-24" aria-hidden>
      {GLYPHS.map(({ src, from }) => (
        <img
          key={src}
          src={src}
          alt=""
          className="lw-welcome-glyph absolute inset-0 size-24"
          data-from={from}
        />
      ))}
      <img src={orielIcon} alt="" className="lw-welcome-mark absolute inset-0 size-24" />
    </div>
  );
}

/**
 * The welcome on the owner's first start, over the whole window: what came over from the old
 * apps, then, when no folder did, one archive folder for all three modes, and a Pane View server
 * for Sync when no profile came over. Every step can be skipped; it lands in View.
 */
function WelcomeCard({ facts, onDone }: { facts: FirstRun; onDone: () => void }) {
  const { bridge, go } = useShell();
  const [folder, setFolder] = useState<string | null>(null);
  const [tidyIt, setTidyIt] = useState(true);
  const [syncIt, setSyncIt] = useState(false);
  const [apiUrl, setApiUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const finish = () => {
    bridge.finishWelcome();
    go("view");
    onDone();
  };

  const start = async () => {
    if (folder === null || problems.length > 0) {
      finish();

      return;
    }

    setBusy(true);

    const met = await bridge.setUpArchive({
      tidy: tidyIt,
      server: syncIt && apiUrl.trim() ? { apiUrl: apiUrl.trim(), token: token.trim() } : null,
    });

    setBusy(false);

    if (met.length > 0) {
      setProblems(met);

      return;
    }

    finish();
  };

  return (
    <section
      aria-label="Welcome to Oriel"
      className="lw-float lw-enter-rise w-[520px] max-w-[calc(100vw-48px)] p-8 text-zinc-900 dark:text-zinc-100"
    >
      <Assembly />
      <h1 className="lw-display mt-6 text-center">Welcome to Oriel</h1>
      <p className="mt-2 text-center text-[13px] text-zinc-500 dark:text-zinc-400">
        View, tidy and sync your archive, in one window.
      </p>
      {facts.migrated ? (
        <p className="lw-card mt-6 flex items-start gap-2.5 px-4 py-3 text-[13px]">
          <Check className="mt-px size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          {facts.migrated}
        </p>
      ) : null}

      {facts.needsFolder ? (
        <div className="mt-6">
          <h2 className="lw-heading">Choose your archive folder</h2>
          <p className="lw-caption mt-0.5">
            View opens it now; Tidy and Sync can take it too. Nothing in it changes until you ask.
          </p>
          <div className="lw-card mt-3 overflow-hidden">
            <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
              <FolderOpen className="size-4 shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">
                  {folder ? baseName(folder) : "No folder yet"}
                </div>
                {folder ? <div className="lw-caption truncate">{folder}</div> : null}
              </div>
              <button
                type="button"
                className="lw-btn lw-btn-secondary"
                onClick={() => void bridge.chooseArchive().then(setFolder)}
              >
                {folder ? "Change…" : "Choose Folder…"}
              </button>
            </div>
            {folder ? (
              <>
                <div className="flex min-h-[48px] items-center gap-4 border-t lw-divider px-4 py-2.5">
                  <div className="min-w-0 flex-1 text-[13px]">
                    Tidy it
                    <p className="lw-caption">Find duplicates, formats to convert and junk.</p>
                  </div>
                  <Switch label="Tidy it" checked={tidyIt} onChange={setTidyIt} />
                </div>
                {facts.needsServer ? (
                  <div className="border-t lw-divider px-4 py-2.5">
                    <div className="flex min-h-[28px] items-center gap-4">
                      <div className="min-w-0 flex-1 text-[13px]">
                        Sync it to Pane View
                        <p className="lw-caption">Push it to your Pane View server.</p>
                      </div>
                      <Switch label="Sync it to Pane View" checked={syncIt} onChange={setSyncIt} />
                    </div>
                    {syncIt ? (
                      <div className="mt-3 grid gap-2 pb-1">
                        <input
                          className="lw-input"
                          aria-label="Pane View API URL"
                          placeholder="https://pane.example.com"
                          value={apiUrl}
                          onChange={(event) => setApiUrl(event.target.value)}
                        />
                        <input
                          className="lw-input"
                          type="password"
                          aria-label="Sync API token"
                          placeholder="Sync API token, saved encrypted in ~/.latch-works"
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {problems.length > 0 ? (
        <ul role="alert" className="mt-4 space-y-1 text-[13px] text-red-700 dark:text-red-300">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-8 flex items-center justify-end gap-2">
        {folder === null && facts.needsFolder ? (
          <button type="button" className="lw-btn lw-btn-ghost" onClick={finish}>
            Skip
          </button>
        ) : null}
        <button
          type="button"
          className="lw-btn lw-btn-primary lw-btn-lg"
          disabled={busy}
          onClick={() => void start()}
        >
          {problems.length > 0 ? "Continue" : busy ? "Setting up…" : "Start"}
        </button>
      </div>
    </section>
  );
}

/** Shows the welcome once, over everything, on the owner's first start. */
export function WelcomeGate() {
  const { bridge } = useShell();
  const [facts, setFacts] = useState<FirstRun | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    void bridge.firstRun().then(setFacts);
  }, [bridge]);

  if (!facts?.show || done) {
    return null;
  }

  return (
    <div className="lw-drag fixed inset-0 z-[60] flex items-center justify-center bg-zinc-100/80 backdrop-blur-xl dark:bg-zinc-950/80">
      <div className="lw-no-drag">
        <WelcomeCard facts={facts} onDone={() => setDone(true)} />
      </div>
    </div>
  );
}
