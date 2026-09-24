import { useEffect, useEffectEvent } from "react";
import { isTextInputTarget } from "./browse-search";

/** The viewer's name for a key press, or null when the press belongs to a text field or a chord. */
function viewerKey(event: KeyboardEvent): string | null {
  if (isTextInputTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
    return null;
  }

  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

export interface ViewerKeyBindings {
  /**
   * Actions by key name: the key itself, lower-cased when it is one character.
   * A bound key's default is prevented.
   */
  keys: Readonly<Record<string, () => void>>;
  /** Runs first on every key press, bound or not. */
  onAnyKey?: () => void;
  onBlur?: () => void;
  onKeyUp?: (event: KeyboardEvent) => void;
}

/** Window-wide viewer keys; each render's bindings are the live ones. */
export function useViewerKeyboard({ keys, onAnyKey, onBlur, onKeyUp }: ViewerKeyBindings): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    onAnyKey?.();

    const key = viewerKey(event);
    const action = key !== null && Object.hasOwn(keys, key) ? keys[key] : undefined;

    if (action) {
      event.preventDefault();
      action();
    }
  });

  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => onKeyUp?.(event));
  const handleBlur = useEffectEvent(() => onBlur?.());

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);
}
