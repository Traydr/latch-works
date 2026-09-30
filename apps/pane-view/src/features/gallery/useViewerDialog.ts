import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { closeDialog, openDialog } from "@/lib/modal-dialog";
import { fullscreenElementOf, onFullscreenChange, toggleFullscreen } from "./fullscreen";

/** The gallery tile for `mediaId`, when the grid has it rendered. */
function renderedMediaTile(mediaId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-browser-entry="media:${CSS.escape(mediaId)}"]`);
}

export interface ViewerDialog {
  closeButtonRef: RefObject<HTMLButtonElement | null>;
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** What goes fullscreen: a wrapper inside the dialog, as Chromium refuses a dialog. */
  fullscreenRef: RefObject<HTMLDivElement | null>;
  isFullscreen: boolean;
  toggleFullscreen: () => void;
}

/**
 * The viewer's modal dialog: open for the viewer's whole life, so the
 * fullscreen its content wrapper may hold survives a step. Focus starts on the
 * close button and returns to the tile of the item on screen at close, else to
 * where the viewer opened from. Where the wrapper cannot go fullscreen,
 * `videoRef`'s video can.
 */
export function useViewerDialog(
  itemId: string,
  videoRef: RefObject<HTMLVideoElement | null>,
): ViewerDialog {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const itemIdRef = useRef(itemId);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    itemIdRef.current = itemId;
  }, [itemId]);

  useEffect(
    () => onFullscreenChange(() => setIsFullscreen(fullscreenElementOf(document) !== null)),
    [],
  );

  // Opened before paint so the gallery never shows through for a frame.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const active = document.activeElement;
    const openedFrom = active instanceof HTMLElement ? active : null;

    if (dialog && !dialog.open) {
      openDialog(dialog);
    }

    closeButtonRef.current?.focus();

    return () => {
      if (dialog) {
        closeDialog(dialog);
      }

      (renderedMediaTile(itemIdRef.current) ?? openedFrom)?.focus();
    };
  }, []);

  const toggle = useCallback(() => {
    const target = fullscreenRef.current;

    if (target) {
      void toggleFullscreen(target, videoRef.current);
    }
  }, [videoRef]);

  return { closeButtonRef, dialogRef, fullscreenRef, isFullscreen, toggleFullscreen: toggle };
}
