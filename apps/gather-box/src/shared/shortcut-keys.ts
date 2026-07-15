export type GatherShortcutAction = "toggle" | "download";

export function installShortcutKeyListener(
  document: Document,
  isEnabled: () => boolean,
  onShortcut: (action: GatherShortcutAction) => void
): () => void {
  let rightShiftDown = false;

  const handleKeydown = (event: KeyboardEvent) => {
    if (isRightShift(event)) {
      rightShiftDown = true;
      return;
    }

    if (!isEnabled() || !rightShiftDown || event.repeat || isEditableTarget(event.target)) {
      return;
    }

    const action = isRightBracket(event)
      ? "toggle"
      : isLeftBracket(event)
        ? "download"
        : null;
    if (!action) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onShortcut(action);
  };

  const handleKeyup = (event: KeyboardEvent) => {
    if (isRightShift(event)) {
      rightShiftDown = false;
    }
  };

  const resetRightShift = () => {
    rightShiftDown = false;
  };

  const pageWindow = document.defaultView;
  if (pageWindow) {
    pageWindow.addEventListener("keydown", handleKeydown, true);
    pageWindow.addEventListener("keyup", handleKeyup, true);
    pageWindow.addEventListener("blur", resetRightShift);
  } else {
    document.addEventListener("keydown", handleKeydown, true);
    document.addEventListener("keyup", handleKeyup, true);
  }

  return () => {
    if (pageWindow) {
      pageWindow.removeEventListener("keydown", handleKeydown, true);
      pageWindow.removeEventListener("keyup", handleKeyup, true);
      pageWindow.removeEventListener("blur", resetRightShift);
    } else {
      document.removeEventListener("keydown", handleKeydown, true);
      document.removeEventListener("keyup", handleKeyup, true);
    }
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isRightShift(event: KeyboardEvent): boolean {
  return event.code === "ShiftRight" || (event.key === "Shift" && event.location === 2);
}

function isRightBracket(event: KeyboardEvent): boolean {
  return event.code === "BracketRight" || event.key === "]" || event.key === "}";
}

function isLeftBracket(event: KeyboardEvent): boolean {
  return event.code === "BracketLeft" || event.key === "[" || event.key === "{";
}
