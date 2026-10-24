/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

declare global {
  // The hidden transcoder window's Vite globals, generated from its renderer entry's name.
  const TRANSCODER_VITE_DEV_SERVER_URL: string;
  const TRANSCODER_VITE_NAME: string;
}

export {};
