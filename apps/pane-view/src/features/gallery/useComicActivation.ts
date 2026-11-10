import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthorizedErrorSchema } from "@/features/auth/unauthorized";
import type { GalleryBrowseSession } from "@/features/gallery/useGalleryBrowse";
import type { GalleryComic } from "@/features/library/listing-contract";

export interface ComicActivation {
  /** The comic open in the reader, if any. */
  activeComic: GalleryComic | null;
  closeComicReader: () => void;
  openComicReader: (comicId: string) => void;
  /** Why the latest activation could not open its comic, if it failed. */
  openError: string | null;
  /** The comic whose full entry is loading for the reader, if any. */
  openingComicId: string | null;
}

/**
 * Keep the card visible with a loading affordance; open the reader only once
 * the complete comic has arrived. A second activation hits the cache. Only the
 * latest activation, in the browse it was made from, may open the reader: an
 * earlier or superseded request resolving late is dropped, and so is its error.
 * A signed-out session goes to the login page.
 */
export function useComicActivation(
  browseKey: string,
  openComic: GalleryBrowseSession["openComic"],
): ComicActivation {
  const [activeComic, setActiveComic] = useState<GalleryComic | null>(null);
  const [openingComicId, setOpeningComicId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const comicActivationRef = useRef<{ browseKey: string; comicId: string } | null>(null);

  const openComicReader = useCallback(
    (comicId: string) => {
      const activation = { browseKey, comicId };
      comicActivationRef.current = activation;
      setOpeningComicId(comicId);
      setOpenError(null);
      void (async () => {
        try {
          const comic = await openComic(comicId);

          if (comicActivationRef.current === activation) {
            setActiveComic(comic);
          }
        } catch (error) {
          if (UnauthorizedErrorSchema.safeParse(error).success) {
            window.location.assign("/login");
          } else if (comicActivationRef.current === activation) {
            setOpenError(error instanceof Error ? error.message : String(error));
          }
        } finally {
          if (comicActivationRef.current === activation) {
            comicActivationRef.current = null;
            setOpeningComicId(null);
          }
        }
      })();
    },
    [browseKey, openComic],
  );

  // Leaving the browse cancels a pending activation.
  useEffect(() => {
    setOpenError(null);

    if (comicActivationRef.current && comicActivationRef.current.browseKey !== browseKey) {
      comicActivationRef.current = null;
      setOpeningComicId(null);
    }
  }, [browseKey]);

  const closeComicReader = useCallback(() => setActiveComic(null), []);

  return { activeComic, closeComicReader, openComicReader, openError, openingComicId };
}
