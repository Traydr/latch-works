import type { EncoderCapabilities, RootId } from "@latch-works/glazier-core/contract";
import { ChevronRight, Folder, X } from "lucide-react";
import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../../../../shell/Settings";
import { Segmented, StartTruncate, Switch } from "../../../../ui/ui";
import { useFolderPicker } from "../components/FolderPicker";
import { useToasts } from "../components/Toasts";
import { useEngine } from "../lib/engine-state";
import { SIMILARITY_LEVELS, VIDEO_QUALITIES } from "../lib/preferences";

const ENCODERS = [
  { label: "H.264 video", has: (capabilities) => capabilities.video.avc },
  { label: "HEVC video", has: (capabilities) => capabilities.video.hevc },
  { label: "AV1 video", has: (capabilities) => capabilities.video.av1 || capabilities.svtAv1 },
  { label: "AAC audio", has: (capabilities) => capabilities.aac },
  { label: "ffmpeg", has: (capabilities) => capabilities.ffmpeg },
  { label: "ffprobe", has: (capabilities) => capabilities.ffprobe },
] as const satisfies ReadonlyArray<{
  label: string;
  has: (capabilities: EncoderCapabilities) => boolean;
}>;

/**
 * A picked folder as a path inside the root, with forward slashes ("" for the root itself), or
 * null when it lies outside.
 */
function insideRoot(rootPath: string, folder: string): string | null {
  const base = rootPath.replace(/[\\/]+$/, "");
  const target = folder.replace(/[\\/]+$/, "");

  if (target === base) {
    return "";
  }

  return target.startsWith(`${base}/`) || target.startsWith(`${base}\\`)
    ? target.slice(base.length + 1).replaceAll("\\", "/")
    : null;
}

/**
 * What this machine can encode, as one summary row. It opens by itself only when something is
 * missing, since a full set is nothing to act on.
 */
function Encoders({ capabilities }: { capabilities: EncoderCapabilities }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const missing = ENCODERS.filter((encoder) => !encoder.has(capabilities)).length;
  const expanded = open ?? missing > 0;

  return (
    <>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="lw-focus lw-hover flex min-h-[52px] w-full items-center gap-3 border-t lw-divider px-4 py-2.5 text-left first:border-t-0"
      >
        <span className="min-w-0 flex-1 text-[13px]">Encoders</span>
        {missing > 0 ? (
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {missing} of {ENCODERS.length} missing
          </span>
        ) : (
          <span className="lw-caption">All {ENCODERS.length} available</span>
        )}
        <ChevronRight
          className={`size-4 shrink-0 text-zinc-400 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
      </button>
      {expanded
        ? ENCODERS.map((encoder) => {
            const found = encoder.has(capabilities);

            return (
              <div
                key={encoder.label}
                className={`flex h-10 items-center gap-4 border-t lw-divider px-4 text-[13px] ${
                  found ? "text-zinc-600 dark:text-zinc-300" : "text-amber-700 dark:text-amber-300"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{encoder.label}</span>
                {found ? <span className="lw-caption">Available</span> : <span>Not found</span>}
              </div>
            );
          })
        : null}
    </>
  );
}

/**
 * Tidy's section of Settings: how duplicates are chosen and converted, and background analysis.
 * Preferred folders belong to the folder being tidied, so they show only once there is one.
 */
export function TidySettings({ rootId }: { rootId: RootId | null }) {
  const { settings, setSettings, capabilities, roots, report } = useEngine();
  const toasts = useToasts();
  const pickFolder = useFolderPicker();
  const root = roots.find((candidate) => candidate.id === rootId);

  if (!settings) {
    return null;
  }

  const preferredHere = settings.preferredFolders.filter((entry) => entry.rootId === rootId);
  const rootName = root?.name ?? "this folder";

  const addFolder = async () => {
    if (!root || rootId === null) {
      return;
    }

    let folder: string | null = null;

    try {
      folder = await pickFolder({
        title: "Prefer a folder",
        action: "Prefer",
        within: { path: root.path, name: root.name },
      });
    } catch (error) {
      report(error);
    }

    if (!folder) {
      return;
    }

    const dir = insideRoot(root.path, folder);

    if (dir === null) {
      toasts.show({
        message: `That folder is outside ${root.name}`,
        detail: "Preferred folders have to be inside the folder being tidied.",
        tone: "error",
      });

      return;
    }

    if (preferredHere.some((entry) => entry.dir === dir)) {
      toasts.show({ message: `${dir || root.name} is already preferred`, tone: "info" });

      return;
    }

    await setSettings({
      ...settings,
      preferredFolders: [...settings.preferredFolders, { rootId, dir }],
    });
  };

  const removeFolder = (dir: string) =>
    void setSettings({
      ...settings,
      preferredFolders: settings.preferredFolders.filter(
        (entry) => !(entry.rootId === rootId && entry.dir === dir),
      ),
    });

  return (
    <>
      <SettingsGroup
        title={
          root ? (
            <>
              Duplicates <span className="font-normal text-zinc-500">· for {rootName}</span>
            </>
          ) : (
            "Duplicates"
          )
        }
      >
        {root ? (
          <SettingsRow
            label="Preferred folders"
            description="Review keeps the copy in these folders first. P on a version adds its folder."
          >
            <button
              type="button"
              className="lw-btn lw-btn-secondary"
              onClick={() => void addFolder()}
            >
              Add folder…
            </button>
          </SettingsRow>
        ) : null}
        {preferredHere.map((entry) => (
          <div
            key={entry.dir}
            className="flex h-11 items-center gap-3 border-t lw-divider pr-2.5 pl-4"
          >
            <Folder className="size-4 shrink-0 text-zinc-400" />
            <StartTruncate text={entry.dir || rootName} className="min-w-0 flex-1 text-[13px]" />
            <button
              type="button"
              className="lw-btn lw-btn-ghost lw-btn-icon-sm"
              aria-label={`Stop preferring ${entry.dir || rootName}`}
              title="Stop preferring"
              onClick={() => removeFolder(entry.dir)}
            >
              <X />
            </button>
          </div>
        ))}
        <SettingsRow
          label="Similar versions"
          description="How alike two pictures or videos must look to count as one"
        >
          <Segmented
            label="Similar versions"
            options={SIMILARITY_LEVELS}
            value={settings.similarity}
            onChange={(similarity) => void setSettings({ ...settings, similarity })}
          />
        </SettingsRow>
        <SettingsRow
          label="Spot variants"
          description="Keep pictures that differ in one area, like a face, an outfit or a caption's language, and keep each picture's copy in the folder with the rest of its set"
        >
          <Switch
            label="Spot variants"
            checked={settings.spotVariants}
            onChange={(spotVariants) => void setSettings({ ...settings, spotVariants })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="Convert">
        <SettingsRow
          label="Video quality"
          description="Used when a video has to be re-encoded. Shrink's AV1 runs at CRF 40, 35 or 30"
        >
          <Segmented
            label="Video quality"
            options={VIDEO_QUALITIES}
            value={settings.reencodeQuality}
            onChange={(reencodeQuality) => void setSettings({ ...settings, reencodeQuality })}
          />
        </SettingsRow>
        {capabilities ? <Encoders capabilities={capabilities} /> : null}
      </SettingsGroup>

      <SettingsGroup title="Background analysis">
        <SettingsRow label="Find similar versions and measure soundtracks after each scan">
          <Switch
            label="Background analysis"
            checked={settings.autoAnalyze}
            onChange={(autoAnalyze) => void setSettings({ ...settings, autoAnalyze })}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}
