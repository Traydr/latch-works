import type {
  ConfirmRequest,
  Json,
  MenuEntry,
  TranscoderJobMessage,
  TranscoderOutbound,
} from "./messages";

/** What the main window's preload exposes as `window.glazier`. Results are parsed by the caller. */
export interface GlazierBridge {
  /** `process.platform`: macOS draws its window buttons over the app's own top bar. */
  platform: string;
  call(method: string, input: Json): Promise<Json>;
  onEvent(listener: (event: Json) => void): () => void;
  /** The folders inside a folder, unparsed `FolderListing`; `~` is the home folder. */
  listFolder(folder: string): Promise<Json>;
  /** Home, its usual folders and mounted drives, unparsed `FolderPlaces`. */
  folderPlaces(): Promise<Json>;
  reveal(filePath: string): Promise<void>;
  open(filePath: string): Promise<void>;
  quickLook(filePath: string): Promise<void>;
  emptyHolding(rootId: number): Promise<Json>;
  /** Pops a native menu at the pointer; resolves with the chosen item's id, or null. */
  showMenu(entries: MenuEntry[]): Promise<string | null>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** The path of a file or folder dropped on the window. */
  pathForFile(file: File): string;
  /** App menu commands, unparsed. */
  onCommand(listener: (command: Json) => void): () => void;
  /** Tells the main process a run of several changes is going, so quitting waits for it. */
  setBusy(busy: boolean): void;
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
