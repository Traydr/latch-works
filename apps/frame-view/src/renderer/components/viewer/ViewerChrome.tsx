import {
  ChevronLeft,
  ChevronRight,
  Copy,
  FolderOpen,
  type LucideIcon,
  Maximize,
  Minimize,
  X,
} from 'lucide-react';
import type { JSX } from 'react';

import type { MediaItem } from '../../../shared/types';

interface ViewerChromeProps {
  canStepBackward: boolean;
  canStepForward: boolean;
  chromeVisibilityClass: string;
  details: string[];
  isFullscreen: boolean;
  item: MediaItem;
  onClose: () => void;
  onStep: (delta: number) => void;
  onToggleFullscreen: () => void;
}

/** The chrome every media type shares: title bar with file actions, and the step arrows. */
export function ViewerChrome({
  canStepBackward,
  canStepForward,
  chromeVisibilityClass,
  details,
  isFullscreen,
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
            <ViewerToolbarButton
              icon={Copy}
              label="Copy path"
              onClick={() => void navigator.clipboard.writeText(item.path)}
            />
            <ViewerToolbarButton
              icon={FolderOpen}
              label="Reveal in folder"
              onClick={() => void window.frameView.revealInFolder(item.path)}
            />
            <ViewerToolbarButton
              icon={isFullscreen ? Minimize : Maximize}
              label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={onToggleFullscreen}
            />
            <ViewerToolbarButton icon={X} label="Close" onClick={onClose} />
          </div>
        </div>
      </div>

      <StepArrow
        chromeVisibilityClass={chromeVisibilityClass}
        direction={-1}
        enabled={canStepBackward}
        onStep={onStep}
      />
      <StepArrow
        chromeVisibilityClass={chromeVisibilityClass}
        direction={1}
        enabled={canStepForward}
        onStep={onStep}
      />
    </>
  );
}

function ViewerToolbarButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="viewer-overlay-btn"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Icon className="size-5" />
    </button>
  );
}

/** A tall pill at the viewer's edge; one per side, so the e2e can address each by name. */
function StepArrow({
  chromeVisibilityClass,
  direction,
  enabled,
  onStep,
}: {
  chromeVisibilityClass: string;
  direction: -1 | 1;
  enabled: boolean;
  onStep: (delta: number) => void;
}): JSX.Element {
  const Icon = direction < 0 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={direction < 0 ? 'Previous item' : 'Next item'}
      className={`viewer-chrome-transition absolute top-1/2 z-20 flex h-[25dvh] min-h-11 w-12 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-white/90 hover:bg-violet-500/25 hover:text-violet-100 ${direction < 0 ? 'left-3' : 'right-3'} ${chromeVisibilityClass} ${enabled ? '' : 'pointer-events-none opacity-40'}`}
      onClick={() => onStep(direction)}
      disabled={!enabled}
    >
      <Icon className="size-6" />
    </button>
  );
}
