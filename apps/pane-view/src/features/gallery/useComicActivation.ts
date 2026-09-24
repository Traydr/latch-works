import type { ComicEntry } from "@latch-works/media-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GalleryBrowseSession } from "@/features/gallery/useGalleryBrowse";

export interface ComicActivation {
  /** The comic open in the reader, if any. */
  activeComic: ComicEntry | null;
  closeComicReader: () => void;
  openComicReader: (comicId: string) => void;
  /** The comic whose full entry is loading for the reader, if any. */
  openingComicId: string | null;
}

/**
 * Keep the card visible with a loading affordance; open the reader only once
 * the complete comic has arrived. A second activation hits the cache. Only the
 * latest activation, in the browse it was made from, may open the reader: an
 * earlier or superseded request resolving late is dropped.
 */
export function useComicActivation(
  browseKey: string,
  openComic: GalleryBrowseSession["openComic"],
): ComicActivation {
  const [activeComic, setActiveComic] = useState<ComicEntry | null>(null);
  const [openingComicId, setOpeningComicId] = useState<string | null>(null);
  const comicActivationRef = useRef<{ browseKey: string; comicId: string } | null>(null);

  const openComicReader = useCallback(
    (comicId: string) => {
      const activation = { browseKey, comicId };
      comicActivationRef.current = activation;
      setOpeningComicId(comicId);
      void openComic(comicId)
        .then((comic) => {
          if (comicActivationRef.current === activation) {
            setActiveComic(comic);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (comicActivationRef.current === activation) {
            comicActivationRef.current = null;
            setOpeningComicId(null);
          }
        });
    },
    [browseKey, openComic],
  );

  // Leaving the browse cancels a pending activation.
  useEffect(() => {
    if (comicActivationRef.current && comicActivationRef.current.browseKey !== browseKey) {
      comicActivationRef.current = null;
      setOpeningComicId(null);
    }
  }, [browseKey]);

  const closeComicReader = useCallback(() => setActiveComic(null), []);

  return { activeComic, closeComicReader, openComicReader, openingComicId };
}
