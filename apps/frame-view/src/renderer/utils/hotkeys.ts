export const HOTKEYS = {
  close: ['Escape'],
  galleryActivate: ['Enter', 'f'],
  galleryMoveDown: ['ArrowDown', 's'],
  galleryMoveLeft: ['ArrowLeft', 'a'],
  galleryMoveRight: ['ArrowRight', 'd'],
  galleryMoveUp: ['ArrowUp', 'w'],
  openParentFolder: ['Shift+W'],
  openSelectedFolder: ['Shift+S'],
  previousFolder: ['Shift+A'],
  nextFolder: ['Shift+D'],
  viewerNext: ['ArrowRight', 'e'],
  viewerPrevious: ['ArrowLeft', 'q'],
  videoPlayPause: [' ', '2'],
  videoSeekBackward: ['1'],
  videoSeekForward: ['3'],
  videoTemporarySpeed: ['4'],
} as const;

export function eventKey(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export function isPlainHotkeyEvent(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

export function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function matchesAnyKey(event: KeyboardEvent, keys: readonly string[]): boolean {
  const key = eventKey(event);
  return keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase());
}

export function formatHotkeys(keys: readonly string[]): string {
  return keys.map((key) => (key === ' ' ? 'Space' : key)).join(' / ');
}
