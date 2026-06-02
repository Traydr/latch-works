import type {
  AppCommand,
  AppSettings,
  AppSettingsPatch,
  DiagnosticsSnapshot,
  FolderNode,
  FrameViewApi,
  FrameViewResult,
  MediaIndexStats,
  MediaToolsStatus,
  ScanEvent,
  ScanOptions,
  VideoProbeMetadata,
  VideoProbeRequest,
} from '../../shared/types';
import { getFrameViewValue, isFrameViewOk } from '../utils/frameViewResult';

interface FrameViewClient {
  openFolderDialog: () => Promise<string | null>;
  resolveInputPath: (candidatePath: string) => Promise<string | null>;
  startScan: (options: ScanOptions) => Promise<boolean>;
  cancelScan: () => Promise<boolean>;
  listFolderChildren: (folderPath: string) => Promise<FolderNode[]>;
  getSettings: () => Promise<AppSettings | null>;
  updateSettings: (patch: AppSettingsPatch) => Promise<AppSettings | null>;
  probeVideoMetadata: (request: VideoProbeRequest) => Promise<VideoProbeMetadata | null>;
  clearThumbnailCache: () => Promise<boolean>;
  getMediaIndexStats: () => Promise<MediaIndexStats | null>;
  clearMediaIndex: () => Promise<boolean>;
  getMediaToolsStatus: () => Promise<MediaToolsStatus | null>;
  getDiagnosticsSnapshot: () => Promise<DiagnosticsSnapshot | null>;
  onAppCommand: (listener: (command: AppCommand) => void) => () => void;
  onScanEvent: (listener: (event: ScanEvent) => void) => () => void;
}

interface FrameViewClientResult {
  startScan: (options: ScanOptions) => Promise<FrameViewResult<void>>;
  cancelScan: () => Promise<FrameViewResult<void>>;
  updateSettings: (patch: AppSettingsPatch) => Promise<FrameViewResult<AppSettings>>;
  clearThumbnailCache: () => Promise<FrameViewResult<void>>;
  clearMediaIndex: () => Promise<FrameViewResult<void>>;
  getMediaToolsStatus: () => Promise<FrameViewResult<MediaToolsStatus>>;
  getDiagnosticsSnapshot: () => Promise<FrameViewResult<DiagnosticsSnapshot>>;
}

function getApi(): FrameViewApi {
  return window.frameView;
}

export const frameViewClient: FrameViewClient = {
  async openFolderDialog() {
    return getFrameViewValue(await getApi().openFolderDialog(), 'open-folder-dialog');
  },
  async resolveInputPath(candidatePath) {
    return getFrameViewValue(await getApi().resolveInputPath(candidatePath), 'resolve-input-path');
  },
  async startScan(options) {
    return isFrameViewOk(await getApi().startScan(options));
  },
  async cancelScan() {
    return isFrameViewOk(await getApi().cancelScan());
  },
  async listFolderChildren(folderPath) {
    return (
      getFrameViewValue(await getApi().listFolderChildren(folderPath), 'list-folder-children') ?? []
    );
  },
  async getSettings() {
    return getFrameViewValue(await getApi().getSettings(), 'get-settings');
  },
  async updateSettings(patch) {
    return getFrameViewValue(await getApi().updateSettings(patch), 'update-settings');
  },
  async probeVideoMetadata(request) {
    return getFrameViewValue(await getApi().probeVideoMetadata(request), 'probe-video-metadata');
  },
  async clearThumbnailCache() {
    return isFrameViewOk(await getApi().clearThumbnailCache());
  },
  async getMediaIndexStats() {
    return getFrameViewValue(await getApi().getMediaIndexStats(), 'get-media-index-stats');
  },
  async clearMediaIndex() {
    return isFrameViewOk(await getApi().clearMediaIndex());
  },
  async getMediaToolsStatus() {
    return getFrameViewValue(await getApi().getMediaToolsStatus(), 'get-media-tools-status');
  },
  async getDiagnosticsSnapshot() {
    return getFrameViewValue(
      await getApi().debug.getDiagnosticsSnapshot(),
      'get-diagnostics-snapshot',
    );
  },
  onAppCommand(listener) {
    return getApi().onAppCommand(listener);
  },
  onScanEvent(listener) {
    return getApi().onScanEvent(listener);
  },
};

export const frameViewClientResult: FrameViewClientResult = {
  startScan(options) {
    return getApi().startScan(options);
  },
  cancelScan() {
    return getApi().cancelScan();
  },
  updateSettings(patch) {
    return getApi().updateSettings(patch);
  },
  clearThumbnailCache() {
    return getApi().clearThumbnailCache();
  },
  clearMediaIndex() {
    return getApi().clearMediaIndex();
  },
  getMediaToolsStatus() {
    return getApi().getMediaToolsStatus();
  },
  getDiagnosticsSnapshot() {
    return getApi().debug.getDiagnosticsSnapshot();
  },
};
