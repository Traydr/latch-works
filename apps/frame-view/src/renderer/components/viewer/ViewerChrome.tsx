import { FolderOpen, Maximize, X } from 'lucide-react';
import type { JSX } from 'react';

import type { MediaItem } from '../../../shared/types';

interface ViewerChromeProps {
  canStepBackward: boolean;
  canStepForward: boolean;
  chromeVisibilityClass: string;
  details: string[];
  item: MediaItem;
  onClose: () => void;
  onStep: (delta: number) => void;
  onToggleFullscreen: () => void;
}

export function ViewerChrome({
  canStepBackward,
  canStepForward,
  chromeVisibilityClass,
  details,
  item,
  onClose,
  onStep,
  onToggleFullscreen,
}: ViewerChromeProps): JSX.Element {
  return (
    <>
      <div
        className={`viewer-scrim-top viewer-chrome-transition ${chromeVisibilityClass}`}
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <div className="pointer-events-auto flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white">{item.name}</p>
            <p className="truncate text-xs text-white/70">{details.join(' · ')}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Close"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="size-5" />
            </button>
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Fullscreen"
              aria-label="Fullscreen"
              onClick={onToggleFullscreen}
            >
              <Maximize className="size-5" />
            </button>
            <button
              type="button"
              className="viewer-overlay-btn"
              title="Reveal in folder"
              aria-label="Reveal in folder"
              onClick={() => void window.frameView.revealInFolder(item.path)}
            >
              <FolderOpen className="size-5" />
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        aria-label="Previous item"
        className={`viewer-overlay-btn absolute left-3 top-1/2 z-20 -translate-y-1/2 viewer-chrome-transition ${chromeVisibilityClass} ${canStepBackward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(-1)}
        disabled={!canStepBackward}
      >
        <span className="px-1 text-xl">{'<'}</span>
      </button>
      <button
        type="button"
        aria-label="Next item"
        className={`viewer-overlay-btn absolute right-3 top-1/2 z-20 -translate-y-1/2 viewer-chrome-transition ${chromeVisibilityClass} ${canStepForward ? '' : 'pointer-events-none opacity-40'}`}
        onClick={() => onStep(1)}
        disabled={!canStepForward}
      >
        <span className="px-1 text-xl">{'>'}</span>
      </button>
    </>
  );
}
