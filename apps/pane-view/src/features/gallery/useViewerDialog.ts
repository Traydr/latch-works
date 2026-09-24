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
  isFullscreen: boolean;
  toggleFullscreen: () => void;
}

/**
 * The viewer's modal dialog: open for the viewer's whole life, so the
 * fullscreen it may hold survives a step. Focus starts on the close button and
 * returns to the tile of the item on screen at close, else to where the viewer
 * opened from. Where the dialog cannot go fullscreen, `videoRef`'s video can.
 */
export function useViewerDialog(
  itemId: string,
  videoRef: RefObject<HTMLVideoElement | null>,
): ViewerDialog {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
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
    const dialog = dialogRef.current;

    if (dialog) {
      void toggleFullscreen(dialog, videoRef.current);
    }
  }, [videoRef]);

  return { closeButtonRef, dialogRef, isFullscreen, toggleFullscreen: toggle };
}
