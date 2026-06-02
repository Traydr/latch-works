// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismLayout } from '../../../src/renderer/layouts';
import { buildBrowserEntryCollection } from '../../../src/renderer/utils/browserEntries';
import { DEFAULT_SETTINGS } from '../../../src/shared/types';

class ResizeObserverStub {
  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

describe('PrismLayout', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: (handle: number) => window.clearTimeout(handle),
    });
  });

  it('renders tiles and forwards toolbar actions', async () => {
    const user = userEvent.setup();
    const onOpenFolder = vi.fn();
    const onOpenSettings = vi.fn();
    const onChangeSortMode = vi.fn();
    const browserEntries = buildBrowserEntryCollection(
      [{ path: 'C:\\media\\folder-a', name: 'folder-a', hasChildren: true }],
      [],
      [
        {
          id: 'media-1',
          path: 'C:\\media\\image.jpg',
          name: 'image.jpg',
          extension: 'jpg',
          mediaType: 'image',
          size: 128,
          mtimeMs: 1,
        },
      ],
      [],
      false,
      false,
      'name-asc',
      false,
    );

    render(
      <PrismLayout
        settings={DEFAULT_SETTINGS}
        rootPath="C:\\media"
        sidebarRootPath="C:\\media"
        scanMessage="Loaded 1 item"
        scanState="done"
        recursive={false}
        comicMode={false}
        folderChildrenLoading={false}
        browserEntries={browserEntries}
        selectedBrowserEntryKey="folder:C:\\media\\folder-a"
        selectedBrowserEntryIndex={0}
        comicEntryCount={browserEntries.comicEntryCount}
        excludedRootChildPaths={[]}
        folderEntryCount={browserEntries.folderEntryCount}
        mediaEntryCount={browserEntries.mediaEntryCount}
        currentFolderPathLabel="media"
        parentFolderPath={null}
        canOpenParentFolder={false}
        canGoToPreviousFolder={false}
        canGoToNextFolder={false}
        cacheStatusMessage={null}
        onOpenFolder={onOpenFolder}
        onRefresh={vi.fn()}
        onToggleRecursive={vi.fn()}
        onToggleComicMode={vi.fn()}
        onToggleExcludedRootChild={vi.fn()}
        onChangeSortMode={onChangeSortMode}
        onShuffleRandom={vi.fn()}
        onOpenSettings={onOpenSettings}
        onRequestVideoMetadata={vi.fn()}
        onSelectFolder={vi.fn()}
        onSelectBrowserEntry={vi.fn()}
        onActivateBrowserEntry={vi.fn()}
        onOpenParentFolder={vi.fn()}
        onOpenPreviousFolder={vi.fn()}
        onOpenNextFolder={vi.fn()}
      />,
    );

    expect(screen.getByText('folder-a')).toBeTruthy();
    expect(screen.getByText('image.jpg')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await user.click(screen.getByRole('button', { name: 'A-Z' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'Random' }));

    expect(onOpenFolder).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onChangeSortMode).toHaveBeenCalledWith('random');
  });
});
