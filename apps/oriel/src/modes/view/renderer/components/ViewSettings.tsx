import { type JSX, useEffect, useState } from "react";

import { SettingsGroup, SettingsRow } from "../../../../shell/Settings";
import { Kbd, Switch } from "../../../../ui/ui";
import type {
  AppSettings,
  AppSettingsPatch,
  DiagnosticsSnapshot,
  MediaIndexStats,
  MediaToolsStatus,
} from "../../shared/types";
import { formatHotkeys, HOTKEYS } from "../utils/hotkeys";
import { VIDEO_SKIP_SECONDS } from "../utils/videoPlayback";
import { type CurrentFolderSummary, ViewDiagnostics } from "./ViewDiagnostics";

interface ViewSettingsProps {
  currentFolderSummary: CurrentFolderSummary;
  diagnosticsSnapshot: DiagnosticsSnapshot | null;
  mediaIndexStats: MediaIndexStats | null;
  mediaToolsStatus: MediaToolsStatus | null;
  onClearMediaIndex: () => void;
  onClearThumbnailCache: () => void;
  onCopyDiagnostics: () => Promise<void> | void;
  onRefreshDiagnostics: () => Promise<void> | void;
  onUpdate: (patch: AppSettingsPatch) => void;
  settings: AppSettings;
}

/** A setting that is on or off, its switch named by the row's label. */
function SwitchRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow label={label} description={description}>
      <Switch label={label} checked={checked} onChange={onChange} />
    </SettingsRow>
  );
}

/** The thumbnail size, saved once the slider is let go rather than at every step. */
function ThumbnailSizeRow({
  settings,
  onUpdate,
}: Pick<ViewSettingsProps, "settings" | "onUpdate">) {
  const [draft, setDraft] = useState(settings.thumbnailSize);

  useEffect(() => {
    setDraft(settings.thumbnailSize);
  }, [settings.thumbnailSize]);

  const save = () => {
    if (draft !== settings.thumbnailSize) {
      onUpdate({ thumbnailSize: draft });
    }
  };

  return (
    <SettingsRow label="Thumbnail size" description={`${draft} px wide`}>
      <input
        type="range"
        aria-label="Thumbnail size"
        min={140}
        max={340}
        step={10}
        value={draft}
        className="w-40 accent-violet-600 dark:accent-violet-500"
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={save}
        onKeyUp={save}
        onBlur={save}
      />
    </SettingsRow>
  );
}

const SHORTCUTS: { title: string; entries: { action: string; keys: string }[] }[] = [
  {
    title: "Gallery keys",
    entries: [
      { action: "Previous or next item", keys: "← / → or A / D" },
      { action: "Row up or down", keys: "↑ / ↓ or W / S" },
      { action: "Open the selected item", keys: formatHotkeys(HOTKEYS.galleryActivate) },
      { action: "Open the selected folder", keys: formatHotkeys(HOTKEYS.openSelectedFolder) },
      {
        action: "Parent, previous or next folder",
        keys: `${formatHotkeys(HOTKEYS.openParentFolder)} / ${formatHotkeys(
          HOTKEYS.previousFolder,
        )} / ${formatHotkeys(HOTKEYS.nextFolder)}`,
      },
    ],
  },
  {
    title: "Viewer keys",
    entries: [
      { action: "Close the viewer", keys: formatHotkeys(HOTKEYS.close) },
      { action: "Previous page or item", keys: formatHotkeys(HOTKEYS.viewerPrevious) },
      { action: "Next page or item", keys: formatHotkeys(HOTKEYS.viewerNext) },
      { action: "Play or pause", keys: formatHotkeys(HOTKEYS.videoPlayPause) },
      {
        action: `Back or forward ${VIDEO_SKIP_SECONDS} seconds`,
        keys: `${formatHotkeys(HOTKEYS.videoSeekBackward)} / ${formatHotkeys(
          HOTKEYS.videoSeekForward,
        )}`,
      },
      { action: "Mute", keys: formatHotkeys(HOTKEYS.videoMute) },
      { action: "Play at 2× while held", keys: formatHotkeys(HOTKEYS.videoTemporarySpeed) },
    ],
  },
];

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`;
}

function describeIndex(stats: MediaIndexStats | null): string {
  if (!stats) {
    return "Counting…";
  }

  return `${count(stats.totalItems, "item", "items")} from ${count(stats.uniqueRoots, "folder", "folders")}`;
}

/**
 * View's section of Oriel's Settings: the gallery and viewer preferences Frame View kept in its
 * settings drawer, its caches, its keys and its diagnostics. The theme is Oriel's own (General).
 */
export function ViewSettings({
  currentFolderSummary,
  diagnosticsSnapshot,
  mediaIndexStats,
  mediaToolsStatus,
  onClearMediaIndex,
  onClearThumbnailCache,
  onCopyDiagnostics,
  onRefreshDiagnostics,
  onUpdate,
  settings,
}: ViewSettingsProps): JSX.Element {
  return (
    <>
      <SettingsGroup title="Gallery">
        <SwitchRow
          label="Remember last folder"
          description="Open it again when Oriel starts."
          checked={settings.rememberLastFolder}
          onChange={(rememberLastFolder) => onUpdate({ rememberLastFolder })}
        />
        <SwitchRow
          label="Enable recursive mode by default"
          description="Show the media in every subfolder too."
          checked={settings.recursiveDefault}
          onChange={(recursiveDefault) => onUpdate({ recursiveDefault })}
        />
        <ThumbnailSizeRow settings={settings} onUpdate={onUpdate} />
        <SwitchRow
          label="Show images"
          checked={settings.filters.showImages}
          onChange={(showImages) => onUpdate({ filters: { ...settings.filters, showImages } })}
        />
        <SwitchRow
          label="Show videos"
          checked={settings.filters.showVideos}
          onChange={(showVideos) => onUpdate({ filters: { ...settings.filters, showVideos } })}
        />
        <SwitchRow
          label="Autoplay video on hover"
          checked={settings.autoplayOnHover}
          onChange={(autoplayOnHover) => onUpdate({ autoplayOnHover })}
        />
        <SwitchRow
          label="Enable audio in video preview"
          checked={settings.previewAudioEnabled}
          onChange={(previewAudioEnabled) => onUpdate({ previewAudioEnabled })}
        />
      </SettingsGroup>

      <SettingsGroup title="Viewer">
        <SwitchRow
          label="Autoplay videos in viewer"
          checked={settings.autoplayVideos}
          onChange={(autoplayVideos) => onUpdate({ autoplayVideos })}
        />
        <SwitchRow
          label="Loop videos"
          checked={settings.loopVideos}
          onChange={(loopVideos) => onUpdate({ loopVideos })}
        />
        <SwitchRow
          label="Loop viewer navigation"
          description="Step from the last item back to the first."
          checked={settings.loopViewerNavigation}
          onChange={(loopViewerNavigation) => onUpdate({ loopViewerNavigation })}
        />
      </SettingsGroup>

      <SettingsGroup title="Storage">
        <SettingsRow
          label="Thumbnail cache"
          description="Kept so folders open quickly; made again as they are needed."
        >
          <button type="button" className="gz-btn gz-btn-secondary" onClick={onClearThumbnailCache}>
            Clear thumbnail cache
          </button>
        </SettingsRow>
        <SettingsRow label="Media index" description={describeIndex(mediaIndexStats)}>
          <button type="button" className="gz-btn gz-btn-secondary" onClick={onClearMediaIndex}>
            Clear media index
          </button>
        </SettingsRow>
        <SettingsRow
          label="ffmpeg and ffprobe"
          description={
            mediaToolsStatus
              ? (mediaToolsStatus.ffmpegPath ?? "No ffmpeg in this build")
              : "Checking…"
          }
        >
          {mediaToolsStatus ? (
            <span className="gz-caption">
              {mediaToolsStatus.ffmpegAvailable && mediaToolsStatus.ffprobeAvailable
                ? "Available"
                : "Not available"}
            </span>
          ) : null}
        </SettingsRow>
      </SettingsGroup>

      {SHORTCUTS.map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.entries.map((entry) => (
            <SettingsRow key={entry.action} label={entry.action}>
              <Kbd>{entry.keys}</Kbd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      ))}

      <ViewDiagnostics
        currentFolderSummary={currentFolderSummary}
        diagnosticsSnapshot={diagnosticsSnapshot}
        mediaIndexStats={mediaIndexStats}
        onCopyDiagnostics={onCopyDiagnostics}
        onRefreshDiagnostics={onRefreshDiagnostics}
        onUpdate={onUpdate}
        settings={settings}
      />
    </>
  );
}
