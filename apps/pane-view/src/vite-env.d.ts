interface ImportMetaEnv {
  /** Names this build: the service worker keys its caches by it (vite.config.ts sets it). */
  readonly VITE_PANE_VIEW_BUILD_ID: string;
}
