import type { RootId, VideoCodecChoice, VideoQuality } from "@latch-works/glazier-core/contract";
import { X } from "lucide-react";
import { useState } from "react";

import { Panel, Toggle, ViewHeader } from "../components/ui";
import { useEngine, useEngineQuery } from "../lib/engine-state";

const CODECS = [
  { value: "avc", label: "H.264" },
  { value: "hevc", label: "HEVC" },
  { value: "av1", label: "AV1" },
] as const satisfies ReadonlyArray<{ value: VideoCodecChoice; label: string }>;

const QUALITIES = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "very-high", label: "Very high" },
] as const satisfies ReadonlyArray<{ value: VideoQuality; label: string }>;

function Availability({ label, available }: { label: string; available: boolean }) {
  return (
    <li className="flex justify-between">
      <span>{label}</span>
      <span className={available ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}>
        {available ? "Available" : "Unavailable"}
      </span>
    </li>
  );
}

export function SettingsView({ rootId }: { rootId: RootId }) {
  const { settings, setSettings, capabilities, roots } = useEngine();
  const folders = useEngineQuery("listFolders", { rootId });
  const [folder, setFolder] = useState("");
  const root = roots.find((candidate) => candidate.id === rootId);

  if (!settings) {
    return null;
  }

  const protectedHere = settings.protectedFolders.filter((entry) => entry.rootId === rootId);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ViewHeader title="Settings" />
      <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-5 text-xs">
        <Panel title={`Protected folders in ${root?.name ?? "this root"}`}>
          <p className="mb-2 text-zinc-500">
            Duplicate review always keeps a copy in a protected folder, and warns before removing
            one.
          </p>
          <ul className="mb-2 space-y-1">
            {protectedHere.map((entry) => (
              <li key={entry.dir} className="flex items-center justify-between gap-2">
                <span className="truncate">{entry.dir || "(the whole root)"}</span>
                <button
                  type="button"
                  className="ls-btn ls-btn-ghost px-1"
                  aria-label={`Unprotect ${entry.dir}`}
                  onClick={() =>
                    void setSettings({
                      ...settings,
                      protectedFolders: settings.protectedFolders.filter(
                        (candidate) =>
                          !(candidate.rootId === rootId && candidate.dir === entry.dir),
                      ),
                    })
                  }
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              className="ls-input py-1 text-xs"
              list="glazier-folders"
              placeholder="Folder inside the root"
              aria-label="Folder to protect"
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
            <datalist id="glazier-folders">
              {(folders.data ?? []).map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
            <button
              type="button"
              className="ls-btn"
              disabled={!folders.data?.includes(folder.replace(/^\/+|\/+$/g, ""))}
              onClick={() => {
                const dir = folder.replace(/^\/+|\/+$/g, "");
                void setSettings({
                  ...settings,
                  protectedFolders: [...settings.protectedFolders, { rootId, dir }],
                });
                setFolder("");
              }}
            >
              Protect
            </button>
          </div>
        </Panel>

        <Panel title="Similar media">
          <p className="mb-2 text-zinc-500">
            How alike two fingerprints must be to count as the same picture or footage.
          </p>
          <Toggle
            label="Similarity"
            value={settings.similarity}
            onChange={(similarity) => void setSettings({ ...settings, similarity })}
            options={[
              { value: "strict", label: "Strict" },
              { value: "balanced", label: "Balanced" },
              { value: "loose", label: "Loose" },
            ]}
          />
        </Panel>

        <Panel title="Video re-encoding defaults">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Codec</span>
              <Toggle
                label="Default codec"
                value={settings.reencodeCodec}
                onChange={(reencodeCodec) => void setSettings({ ...settings, reencodeCodec })}
                options={CODECS}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">Quality</span>
              <Toggle
                label="Default quality"
                value={settings.reencodeQuality}
                onChange={(reencodeQuality) => void setSettings({ ...settings, reencodeQuality })}
                options={QUALITIES}
              />
            </div>
            <p className="text-zinc-500">
              The archive container is always MP4; the codec only changes for re-encodes you ask
              for.
            </p>
          </div>
        </Panel>

        <Panel title="Encoders on this machine">
          {capabilities ? (
            <ul className="space-y-1">
              <Availability label="H.264 (WebCodecs)" available={capabilities.video.avc} />
              <Availability label="HEVC (WebCodecs)" available={capabilities.video.hevc} />
              <Availability label="AV1 (WebCodecs)" available={capabilities.video.av1} />
              <Availability label="AAC (WebCodecs)" available={capabilities.aac} />
              <Availability label="ffmpeg (frames, loudness)" available={capabilities.ffmpeg} />
              <Availability label="ffprobe (video details)" available={capabilities.ffprobe} />
            </ul>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}
