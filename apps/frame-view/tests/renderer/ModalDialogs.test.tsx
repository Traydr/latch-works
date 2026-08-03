// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComicReader } from '../../src/renderer/components/ComicReader';
import { ViewerModal } from '../../src/renderer/components/ViewerModal';
import type { MediaItem } from '../../src/shared/types';
import { createFrameViewMock } from '../frameViewMock';

const imageItem: MediaItem = {
  extension: 'jpg',
  id: 'page-1',
  mediaType: 'image',
  mtimeMs: 1,
  name: 'page-1.jpg',
  path: '/comics/issue-1/page-1.jpg',
  size: 10,
};

const videoItem: MediaItem = {
  extension: 'mp4',
  id: 'video-1',
  mediaType: 'video',
  mtimeMs: 1,
  name: 'video-1.mp4',
  path: '/videos/video-1.mp4',
  size: 20,
};

describe('media modal dialogs', () => {
  const showModal = vi.fn(function showModal(this: HTMLDialogElement): void {
    this.setAttribute('open', '');
  });
  const close = vi.fn(function close(this: HTMLDialogElement): void {
    this.removeAttribute('open');
  });

  beforeEach(() => {
    showModal.mockClear();
    close.mockClear();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: showModal,
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: close,
    });
    window.frameView = createFrameViewMock();
  });

  afterEach(() => cleanup());

  it('opens the viewer as a native modal and labels the seek control', () => {
    const onClose = vi.fn();
    render(
      <ViewerModal
        items={[videoItem]}
        index={0}
        autoplayVideos={false}
        loopVideos={false}
        canStepBackward={false}
        canStepForward={false}
        onClose={onClose}
        onStep={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Viewer for video-1.mp4' });
    expect(showModal).toHaveBeenCalledOnce();
    expect(screen.getByRole('slider', { name: 'Seek video' }).hasAttribute('disabled')).toBe(true);

    const cancelEvent = new Event('cancel', { cancelable: true });
    fireEvent(dialog, cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens the comic reader as a native modal and closes through cancel', () => {
    const onClose = vi.fn();
    render(
      <ComicReader
        comic={{
          cover: imageItem,
          folderPath: '/comics/issue-1',
          id: 'issue-1',
          name: 'Issue 1',
          pages: [imageItem],
        }}
        onClose={onClose}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Comic reader for Issue 1' });
    expect(showModal).toHaveBeenCalledOnce();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
