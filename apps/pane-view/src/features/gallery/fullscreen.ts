type FullscreenHost = Partial<Pick<HTMLElement, "requestFullscreen">> &
  Partial<{ webkitRequestFullscreen: () => Promise<void> | void }>;

/** Safari's prefixed fullscreen document API, absent from the DOM lib. */
type WebkitFullscreenDocument = Partial<
  Pick<Document, "exitFullscreen" | "fullscreenElement" | "fullscreenEnabled">
> &
  Partial<{
    webkitExitFullscreen: () => Promise<void> | void;
    webkitFullscreenElement: Element | null;
  }>;

/** iPhone Safari's video-only fullscreen entry point, absent from the DOM lib. */
type WebkitFullscreenVideo = HTMLVideoElement & Partial<{ webkitEnterFullscreen: () => void }>;

export function fullscreenElementOf(document: Document): Element | null {
  const doc: WebkitFullscreenDocument = document;

  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Calls `listener` whenever the page enters or leaves fullscreen; returns the unsubscribe. */
export function onFullscreenChange(listener: () => void): () => void {
  document.addEventListener("fullscreenchange", listener);
  document.addEventListener("webkitfullscreenchange", listener);

  return () => {
    document.removeEventListener("fullscreenchange", listener);
    document.removeEventListener("webkitfullscreenchange", listener);
  };
}

/** Leaves fullscreen, or puts `host` into it, falling back to `video`'s own player. */
export async function toggleFullscreen(
  host: HTMLElement,
  video: HTMLVideoElement | null,
): Promise<void> {
  const doc: WebkitFullscreenDocument = document;

  if (fullscreenElementOf(document)) {
    if (doc.exitFullscreen) await document.exitFullscreen();
    else await doc.webkitExitFullscreen?.();

    return;
  }

  // Element fullscreen where the browser allows it (Safari keeps the prefixed
  // form; iPhone Safari has none, and iPad Safari can refuse it for a modal
  // dialog). When it is unavailable or refused, the video itself can still go
  // full screen with its native player.
  const target: FullscreenHost = host;

  try {
    if (doc.fullscreenEnabled !== false && target.requestFullscreen) {
      await host.requestFullscreen();

      return;
    }

    if (target.webkitRequestFullscreen) {
      await target.webkitRequestFullscreen();

      return;
    }
  } catch {
    // Fall through to the video's own fullscreen.
  }

  const fallback: WebkitFullscreenVideo | null = video;
  fallback?.webkitEnterFullscreen?.();
}
