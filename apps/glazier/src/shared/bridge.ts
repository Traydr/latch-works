import type { Json, TranscoderJobMessage, TranscoderOutbound } from "./messages";

/** What the main window's preload exposes as `window.glazier`. Results are parsed by the caller. */
export interface GlazierBridge {
  call(method: string, input: Json): Promise<Json>;
  onEvent(listener: (event: Json) => void): () => void;
  pickRoot(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
  reveal(filePath: string): Promise<void>;
  open(filePath: string): Promise<void>;
  quickLook(filePath: string): Promise<void>;
  emptyHolding(rootId: number): Promise<Json>;
}

/**
 * What the transcoder window's preload exposes as `window.glazierTranscoder`: its jobs, and file
 * access limited to the paths of the jobs it was sent.
 */
export interface TranscoderBridge {
  onJob(listener: (message: TranscoderJobMessage) => void): void;
  onCancel(listener: (id: number) => void): void;
  send(message: TranscoderOutbound): void;
  openRead(filePath: string): Promise<{ handle: number; size: number }>;
  read(handle: number, start: number, end: number): Promise<Uint8Array<ArrayBuffer>>;
  openWrite(filePath: string): Promise<number>;
  write(handle: number, position: number, data: Uint8Array): Promise<void>;
  close(handle: number): Promise<void>;
  readFile(filePath: string): Promise<Uint8Array<ArrayBuffer>>;
  writeFile(filePath: string, data: Uint8Array): Promise<void>;
}
