import type { RootId, SimilarityLevel, VideoQuality } from "@latch-works/glazier-core/contract";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";

import { useEngine, useEngineQuery } from "../lib/engine-state";
import { Modal, Toggle } from "./ui";

export const SIMILARITY_LEVELS = [
  { value: "strict", label: "Strict" },
  { value: "balanced", label: "Balanced" },
  { value: "loose", label: "Loose" },
] as const satisfies ReadonlyArray<{ value: SimilarityLevel; label: string }>;

const QUALITIES = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "very-high", label: "Very high" },
] as const satisfies ReadonlyArray<{ value: VideoQuality; label: string }>;

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t ls-divider pt-3 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-xs font-medium">{title}</h3>
        {hint ? <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function trimSlashes(folder: string): string {
  return folder.trim().replace(/^\/+|\/+$/g, "");
}

export function SettingsSheet({ rootId, onClose }: { rootId: RootId | null; onClose: () => void }) {
  const { settings, setSettings, capabilities, roots } = useEngine();
  const folders = useEngineQuery("listFolders", rootId === null ? null : { rootId });
  const [folder, setFolder] = useState("");
  const root = roots.find((candidate) => candidate.id === rootId);

  if (!settings) {
    return null;
  }

  const preferredHere = settings.preferredFolders.filter((entry) => entry.rootId === rootId);
  const candidate = trimSlashes(folder);

  const canAdd =
    rootId !== null &&
    (folders.data ?? []).includes(candidate) &&
    !preferredHere.some((entry) => entry.dir === candidate);

  return (
    <Modal title="Settings" onClose={onClose} width={520}>
      <div className="space-y-4">
        {rootId !== null ? (
          <Section
            title={`Preferred folders in ${root?.name ?? "this folder"}`}
            hint="Duplicate review keeps the copy in a preferred folder first. Press P on a version to prefer its folder."
          >
            {preferredHere.length > 0 ? (
              <ul className="space-y-1">
                {preferredHere.map((entry) => (
                  <li
                    key={entry.dir}
                    className="flex items-center justify-between gap-2 rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800/60"
                  >
                    <span className="ls-mono truncate text-[11px]">{entry.dir || "/"}</span>
                    <button
                      type="button"
                      className="ls-btn ls-btn-ghost px-1 py-0"
                      aria-label={`Stop preferring ${entry.dir}`}
                      onClick={() =>
                        void setSettings({
                          ...settings,
                          preferredFolders: settings.preferredFolders.filter(
                            (other) => !(other.rootId === rootId && other.dir === entry.dir),
                          ),
                        })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();

                if (canAdd && rootId !== null) {
                  void setSettings({
                    ...settings,
                    preferredFolders: [...settings.preferredFolders, { rootId, dir: candidate }],
                  });
                  setFolder("");
                }
              }}
            >
              <input
                className="ls-input py-1 text-xs"
                list="glazier-folders"
                placeholder="Folder inside this root, such as Photos/2021"
                aria-label="Folder to prefer"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              />
              <datalist id="glazier-folders">
                {(folders.data ?? []).map((entry) => (
                  <option key={entry} value={entry} />
                ))}
              </datalist>
              <button type="submit" className="ls-btn" disabled={!canAdd}>
                Prefer
              </button>
            </form>
          </Section>
        ) : null}

        <Section
          title="Similar versions"
          hint="How alike two pictures or videos must look to count as one."
        >
          <Toggle
            label="Similarity"
            value={settings.similarity}
            onChange={(similarity) => void setSettings({ ...settings, similarity })}
            options={SIMILARITY_LEVELS}
          />
        </Section>

        <Section
          title="Video quality"
          hint="Used when a video has to be re-encoded, and by Re-encode as."
        >
          <Toggle
            label="Video quality"
            value={settings.reencodeQuality}
            onChange={(reencodeQuality) => void setSettings({ ...settings, reencodeQuality })}
            options={QUALITIES}
          />
        </Section>

        <Section title="Background analysis">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-violet-600"
              checked={settings.autoAnalyze}
              onChange={(event) =>
                void setSettings({ ...settings, autoAnalyze: event.target.checked })
              }
            />
            Find similar versions and measure soundtracks after each scan
          </label>
        </Section>

        {capabilities ? (
          <details className="border-t ls-divider pt-3 text-[11px] text-zinc-500">
            <summary className="cursor-default text-xs font-medium text-zinc-700 dark:text-zinc-200">
              Encoders on this machine
            </summary>
            <ul className="ls-mono mt-2 grid grid-cols-2 gap-x-6 gap-y-0.5">
              {(
                [
                  ["H.264", capabilities.video.avc],
                  ["HEVC", capabilities.video.hevc],
                  ["AV1", capabilities.video.av1],
                  ["AAC", capabilities.aac],
                  ["ffmpeg", capabilities.ffmpeg],
                  ["ffprobe", capabilities.ffprobe],
                ] as const
              ).map(([label, available]) => (
                <li key={label} className="flex justify-between">
                  <span>{label}</span>
                  <span className={available ? "text-emerald-600 dark:text-emerald-400" : ""}>
                    {available ? "yes" : "no"}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </Modal>
  );
}
