import { useEffect, useRef, useState } from "react";

export type CopyStatus = "idle" | "copied" | "failed";

const COPY_STATUS_MS = 2_000;

/** `navigator.clipboard` only exists in secure contexts; over plain HTTP it is undefined. */
type OptionalClipboard = Partial<Pick<Navigator, "clipboard">>;

async function writeClipboardText(text: string): Promise<boolean> {
  const { clipboard }: OptionalClipboard = navigator;

  if (!clipboard) {
    return false;
  }

  try {
    await clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}

interface CopyToClipboard {
  copy: (text: string) => Promise<void>;
  status: CopyStatus;
}

/** Copies text and holds the outcome for a moment, for the button that asked. */
export function useCopyToClipboard(): CopyToClipboard {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const copy = async (text: string): Promise<void> => {
    const copied = await writeClipboardText(text);
    setStatus(copied ? "copied" : "failed");

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setStatus("idle");
    }, COPY_STATUS_MS);
  };

  return { copy, status };
}
