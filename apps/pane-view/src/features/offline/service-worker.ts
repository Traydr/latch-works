/** The worker's URL for this build: a new build registers a new URL, which installs a new worker. */
export function serviceWorkerUrl(): string {
  return `/sw.js?v=${encodeURIComponent(import.meta.env.VITE_PANE_VIEW_BUILD_ID)}`;
}

/** The worker runs in production builds only, where the assets it caches have hashed names. */
export function serviceWorkerSupported(): boolean {
  return import.meta.env.PROD && "serviceWorker" in navigator;
}

/**
 * Deletes every cache the app holds. Signing out calls it, so the device keeps nothing of the
 * session. The worker caches only public files (plan 066, D1); clearing them is a precaution.
 */
export async function clearAppCaches(): Promise<void> {
  if (!("caches" in window)) return;

  const names = await caches.keys();
  await Promise.all(names.map((name) => caches.delete(name)));
}
