/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SHOWCASE_PREVIEW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
