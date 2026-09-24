import type { ComicEntry } from "@latch-works/media-domain";
import type { FormEvent, JSX } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ComicReader } from "@/features/comics/ComicReader";
import { MediaViewerModal, type MediaViewerModalProps } from "@/features/gallery/MediaViewerModal";
import { HotkeyOverlay } from "@/features/settings/HotkeyOverlay";
import { SettingsDrawer } from "@/features/settings/SettingsDrawer";
import type { AppSettings, AppSettingsPatch } from "@/features/settings/types";

export interface GalleryOverlaysProps {
  activeComic: ComicEntry | null;
  hotkeysOpen: boolean;
  mobileSearchOpen: boolean;
  onCloseComicReader: () => void;
  onCloseHotkeys: () => void;
  onCloseSettings: () => void;
  onMobileSearchOpenChange: (open: boolean) => void;
  onSearchDraftChange: (draft: string) => void;
  onSubmitSearch: (event: FormEvent<HTMLFormElement>) => void;
  onUpdateRecursiveDefault: (recursive: boolean) => void;
  onUpdateSettings: (patch: AppSettingsPatch) => void;
  /** The settings drawer's "default recursive browsing". */
  recursiveDefault: boolean;
  searchDraft: string;
  settings: AppSettings;
  settingsOpen: boolean;
  /** The media viewer, or null while it is closed. */
  viewer: Pick<
    MediaViewerModalProps,
    "hasMore" | "items" | "mediaId" | "onClose" | "onSelect" | "stepMedia"
  > | null;
}

/** Everything the gallery opens over the grid: drawers, sheets, the viewer, and the reader. */
export function GalleryOverlays({
  activeComic,
  hotkeysOpen,
  mobileSearchOpen,
  onCloseComicReader,
  onCloseHotkeys,
  onCloseSettings,
  onMobileSearchOpenChange,
  onSearchDraftChange,
  onSubmitSearch,
  onUpdateRecursiveDefault,
  onUpdateSettings,
  recursiveDefault,
  searchDraft,
  settings,
  settingsOpen,
  viewer,
}: GalleryOverlaysProps): JSX.Element {
  return (
    <>
      <SettingsDrawer
        onClose={onCloseSettings}
        onUpdate={onUpdateSettings}
        onUpdateRecursiveDefault={onUpdateRecursiveDefault}
        open={settingsOpen}
        recursiveDefault={recursiveDefault}
        settings={settings}
      />
      {hotkeysOpen ? <HotkeyOverlay onClose={onCloseHotkeys} /> : null}
      <Sheet onOpenChange={onMobileSearchOpenChange} open={mobileSearchOpen}>
        <SheetContent className="p-5" side="bottom">
          <SheetHeader>
            <SheetTitle>Search archive</SheetTitle>
          </SheetHeader>
          <form className="mt-4 grid gap-3" onSubmit={onSubmitSearch}>
            <Input
              aria-label="Search archive"
              autoFocus
              onChange={(event) => onSearchDraftChange(event.target.value)}
              placeholder="Search paths"
              type="search"
              value={searchDraft}
            />
            <Button type="submit">Search</Button>
          </form>
        </SheetContent>
      </Sheet>
      {viewer ? (
        <MediaViewerModal
          autoplayVideos={settings.autoplayVideos}
          hasMore={viewer.hasMore}
          items={viewer.items}
          loopNavigation={settings.loopNavigation}
          loopVideos={settings.loopVideos}
          mediaId={viewer.mediaId}
          onClose={viewer.onClose}
          onSelect={viewer.onSelect}
          rememberViewerPosition={settings.rememberViewerPosition}
          stepMedia={viewer.stepMedia}
        />
      ) : null}
      {activeComic ? (
        <ComicReader key={activeComic.id} comic={activeComic} onClose={onCloseComicReader} />
      ) : null}
    </>
  );
}
