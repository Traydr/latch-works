import { ImageExtensions } from '@latch-works/media-domain';
import type { Result } from 'better-result';
import type { z } from 'zod';

import type {
  AppCommandSchema,
  AppSettingsPatchSchema,
  AppSettingsSchema,
  DebugSettingsSchema,
  DiagnosticsSnapshotSchema,
  FileFilterSettingsSchema,
  FolderNodeSchema,
  GallerySortModeSchema,
  IpcErrorPayloadSchema,
  MediaIndexStatsSchema,
  MediaItemSchema,
  MediaToolsStatusSchema,
  MediaTypeSchema,
  RootGalleryPreferencesMapSchema,
  RootGalleryPreferencesSchema,
  ScanEventSchema,
  ScanOptionsSchema,
  ThemeModeSchema,
  VideoProbeMetadataSchema,
  VideoProbeRequestSchema,
} from './contracts';

export type MediaType = z.infer<typeof MediaTypeSchema>;
export type ThemeMode = z.infer<typeof ThemeModeSchema>;
export type GallerySortMode = z.infer<typeof GallerySortModeSchema>;
export type FileFilterSettings = z.infer<typeof FileFilterSettingsSchema>;
export type DebugSettings = z.infer<typeof DebugSettingsSchema>;
export type RootGalleryPreferences = z.infer<typeof RootGalleryPreferencesSchema>;
export type RootGalleryPreferencesMap = z.infer<typeof RootGalleryPreferencesMapSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type AppSettingsPatch = z.infer<typeof AppSettingsPatchSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  rememberLastFolder: true,
  recursiveDefault: false,
  autoplayOnHover: true,
  autoplayVideos: true,
  loopViewerNavigation: true,
  previewAudioEnabled: false,
  loopVideos: true,
  thumbnailSize: 220,
  sortMode: 'name-asc',
  randomSeed: 1,
  filters: {
    imageExtensions: [...ImageExtensions],
    videoExtensions: ['mp4', 'webm', 'mov', 'mkv'],
    showImages: true,
    showVideos: true,
  },
  rootGalleryPreferences: {},
  lastFolderPath: null,
  debug: {
    enableDebugLogging: false,
    enablePerformanceMonitoring: false,
  },
};

export type MediaItem = z.infer<typeof MediaItemSchema>;
export type VideoProbeRequest = z.infer<typeof VideoProbeRequestSchema>;
export type VideoProbeMetadata = z.infer<typeof VideoProbeMetadataSchema>;
export type ScanOptions = z.infer<typeof ScanOptionsSchema>;
export type FolderNode = z.infer<typeof FolderNodeSchema>;
export type ScanEvent = z.infer<typeof ScanEventSchema>;
export type MediaIndexStats = z.infer<typeof MediaIndexStatsSchema>;
export type MediaToolsStatus = z.infer<typeof MediaToolsStatusSchema>;
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;
export type AppCommand = z.infer<typeof AppCommandSchema>;
export type IpcErrorPayload = z.infer<typeof IpcErrorPayloadSchema>;

export type FrameViewResult<T> = Result<T, IpcErrorPayload>;

export interface FrameViewApi {
  openFolderDialog: () => Promise<FrameViewResult<string | null>>;
  resolveInputPath: (candidatePath: string) => Promise<FrameViewResult<string | null>>;
  startScan: (options: ScanOptions) => Promise<FrameViewResult<void>>;
  cancelScan: () => Promise<FrameViewResult<void>>;
  listFolderChildren: (folderPath: string) => Promise<FrameViewResult<FolderNode[]>>;
  getSettings: () => Promise<FrameViewResult<AppSettings>>;
  updateSettings: (patch: AppSettingsPatch) => Promise<FrameViewResult<AppSettings>>;
  revealInFolder: (filePath: string) => Promise<FrameViewResult<void>>;
  probeVideoMetadata: (
    request: VideoProbeRequest,
  ) => Promise<FrameViewResult<VideoProbeMetadata | null>>;
  clearThumbnailCache: () => Promise<FrameViewResult<void>>;
  getMediaIndexStats: () => Promise<FrameViewResult<MediaIndexStats>>;
  clearMediaIndex: () => Promise<FrameViewResult<void>>;
  getMediaToolsStatus: () => Promise<FrameViewResult<MediaToolsStatus>>;
  debug: {
    getDiagnosticsSnapshot: () => Promise<FrameViewResult<DiagnosticsSnapshot>>;
  };
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
  onScanEvent: (listener: (event: ScanEvent) => void) => () => void;
}
