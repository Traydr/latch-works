import { isShowcasePreviewEnabled } from '../../showcase/runtime';

export function toDisplayName(inputPath: string | null): string {
  if (!inputPath) {
    return 'No folder selected';
  }

  const normalized = inputPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : inputPath;
}

export function getParentPath(inputPath: string | null): string | null {
  if (!inputPath) {
    return null;
  }

  const useBackslashes = /^[A-Za-z]:/.test(inputPath) || inputPath.includes('\\');
  const normalized = inputPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized || normalized === '/' || /^[A-Za-z]:$/.test(normalized)) {
    return null;
  }

  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex < 0) {
    return null;
  }

  const parent = normalized.slice(0, lastSlashIndex);
  if (!parent) {
    return '/';
  }

  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}\\`;
  }

  return useBackslashes ? parent.replace(/\//g, '\\') : parent;
}

function toShowcaseMediaUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const fileName = normalized.split('/').pop() ?? normalized;
  return `/showcase-media/${encodeURIComponent(fileName)}`;
}

export function toFileUrl(filePath: string): string {
  if (isShowcasePreviewEnabled()) {
    return toShowcaseMediaUrl(filePath);
  }

  return `frameview-media://media?path=${encodeURIComponent(filePath)}`;
}

export function toThumbnailUrl(filePath: string, size: number, priority?: 0 | 1 | 2): string {
  if (isShowcasePreviewEnabled()) {
    return toShowcaseMediaUrl(filePath);
  }

  const clampedSize = Math.max(64, Math.min(1024, Math.floor(size)));
  const prioritySuffix =
    priority === undefined ? '' : `&priority=${Math.max(0, Math.min(2, Math.floor(priority)))}`;
  return `frameview-media://thumb?path=${encodeURIComponent(filePath)}&size=${clampedSize}${prioritySuffix}`;
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) {
    return '--:--';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
