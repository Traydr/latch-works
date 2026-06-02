import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../../src/renderer/store/useAppStore';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

const initialState = useAppStore.getState();

describe('useAppStore', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true);
  });

  it('appends scan batches into loadingChunks without rebuilding final items', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 1,
      rootPath: 'C:\\gallery',
      recursive: true,
    });

    const itemsReference = useAppStore.getState().items;

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 1,
      items: [
        {
          id: 'a',
          path: 'C:\\gallery\\a.jpg',
          name: 'a.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 1,
        },
      ],
    });

    const state = useAppStore.getState();
    expect(state.items).toBe(itemsReference);
    expect(state.loadingChunks).toHaveLength(1);
    expect(state.loadingChunks[0]?.[0]?.id).toBe('a');
  });

  it('flattens and sorts loading chunks on done', () => {
    useAppStore.getState().initializeSettings({
      ...DEFAULT_SETTINGS,
      sortMode: 'name-asc',
    });

    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 2,
      rootPath: 'C:\\gallery',
      recursive: false,
    });

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 2,
      items: [
        {
          id: 'z',
          path: 'C:\\gallery\\z.jpg',
          name: 'z.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 2,
        },
      ],
    });

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 2,
      items: [
        {
          id: 'a',
          path: 'C:\\gallery\\a.jpg',
          name: 'a.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 1,
        },
      ],
    });

    useAppStore.getState().applyScanEvent({
      type: 'done',
      runId: 2,
      totalItems: 2,
      elapsedMs: 50,
    });

    const state = useAppStore.getState();
    expect(state.loadingChunks).toHaveLength(0);
    expect(state.items.map((item) => item.id)).toEqual(['a', 'z']);
  });

  it('materializes viewerItemsSnapshot once during an active scan', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 3,
      rootPath: 'C:\\gallery',
      recursive: true,
    });

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 3,
      items: [
        {
          id: 'a',
          path: 'C:\\gallery\\a.jpg',
          name: 'a.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 1,
        },
        {
          id: 'b',
          path: 'C:\\gallery\\b.jpg',
          name: 'b.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 2,
        },
      ],
    });

    useAppStore.getState().openViewerAt(0);
    const firstSnapshot = useAppStore.getState().viewerItemsSnapshot;
    useAppStore.getState().openViewerAt(1);
    const secondSnapshot = useAppStore.getState().viewerItemsSnapshot;

    expect(firstSnapshot).not.toBeNull();
    expect(secondSnapshot).toBe(firstSnapshot);
  });

  it('ignores stale run events', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 4,
      rootPath: 'C:\\gallery',
      recursive: false,
    });

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 99,
      items: [
        {
          id: 'stale',
          path: 'C:\\gallery\\stale.jpg',
          name: 'stale.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 10,
          mtimeMs: 1,
        },
      ],
    });

    const state = useAppStore.getState();
    expect(state.loadingChunks).toHaveLength(0);
    expect(state.discoveredItems).toBe(0);
  });

  it('ignores stale completion after a fast scan restart', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 10,
      rootPath: 'C:\\gallery-a',
      recursive: false,
    });
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 11,
      rootPath: 'C:\\gallery-b',
      recursive: true,
    });
    useAppStore.getState().applyScanEvent({
      type: 'done',
      runId: 10,
      totalItems: 99,
      elapsedMs: 10,
    });

    const state = useAppStore.getState();
    expect(state.activeScanRunId).toBe(11);
    expect(state.rootPath).toBe('C:\\gallery-b');
    expect(state.scanState).toBe('loading');
    expect(state.discoveredItems).toBe(0);
  });

  it('patches video metadata across final items, loading chunks, and viewer snapshots', () => {
    const video = {
      id: 'video',
      path: 'C:\\gallery\\video.mp4',
      name: 'video.mp4',
      extension: 'mp4',
      mediaType: 'video' as const,
      size: 10,
      mtimeMs: 1,
    };

    useAppStore.setState({
      items: [video],
      loadingChunks: [[video]],
      viewerItemsSnapshot: [video],
    });

    useAppStore.getState().applyVideoMetadata(video.path, video.mtimeMs, video.size, {
      codec: 'h264',
      durationMs: 1200,
      height: 1080,
      width: 1920,
    });

    const state = useAppStore.getState();
    expect(state.items[0]).toMatchObject({ codec: 'h264', durationMs: 1200 });
    expect(state.loadingChunks[0]?.[0]).toMatchObject({ height: 1080, width: 1920 });
    expect(state.viewerItemsSnapshot?.[0]).toMatchObject({ codec: 'h264' });
  });

  it('keeps large scan batches chunked until completion', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 12,
      rootPath: 'C:\\gallery',
      recursive: false,
    });

    const items = Array.from({ length: 2000 }, (_, index) => ({
      id: `item-${index}`,
      path: `C:\\gallery\\item-${index}.jpg`,
      name: `item-${index}.jpg`,
      extension: 'jpg',
      mediaType: 'image' as const,
      size: 10,
      mtimeMs: index,
    }));

    useAppStore.getState().applyScanEvent({
      type: 'batch',
      runId: 12,
      items,
    });

    expect(useAppStore.getState().items).toHaveLength(0);
    expect(useAppStore.getState().loadingItemCount).toBe(2000);

    useAppStore.getState().applyScanEvent({
      type: 'done',
      runId: 12,
      totalItems: 2000,
      elapsedMs: 100,
    });

    expect(useAppStore.getState().items).toHaveLength(2000);
    expect(useAppStore.getState().loadingChunks).toHaveLength(0);
  });

  it('preserves the active recursive state across settings refreshes', () => {
    useAppStore.getState().applyScanEvent({
      type: 'reset',
      runId: 5,
      rootPath: 'C:\\gallery',
      recursive: true,
    });

    expect(useAppStore.getState().recursive).toBe(true);

    useAppStore.getState().initializeSettings({
      ...DEFAULT_SETTINGS,
      theme: 'dark',
      recursiveDefault: false,
    });

    expect(useAppStore.getState().recursive).toBe(true);
  });
});
