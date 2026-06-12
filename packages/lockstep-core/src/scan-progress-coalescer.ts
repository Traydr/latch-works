import type { ScanArchiveProgress } from "@latch-works/media-index";

export interface ScanProgressCoalescerOptions {
  clearSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
  emit: (progress: ScanArchiveProgress) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  throttleMs?: number;
}

export interface ScanProgressCoalescer {
  dispose(): void;
  flush(): void;
  onProgress(progress: ScanArchiveProgress): void;
}

function progressKey(progress: ScanArchiveProgress): string {
  if (progress.stage === "hashing") {
    return `hashing:${progress.path}`;
  }

  return `scanning:${progress.path ?? ""}`;
}

export function createScanProgressCoalescer(
  options: ScanProgressCoalescerOptions,
): ScanProgressCoalescer {
  const {
    clearSchedule = clearTimeout,
    emit,
    now = () => Date.now(),
    schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    throttleMs = 200,
  } = options;

  let pending: ScanArchiveProgress | null = null;
  let lastEmitKey: string | null = null;
  let lastEmitAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearSchedule(timer);
      timer = null;
    }
  }

  function emitPending(): void {
    if (pending === null) {
      return;
    }

    const progress = pending;
    pending = null;
    lastEmitKey = progressKey(progress);
    lastEmitAt = now();
    emit(progress);
  }

  function flush(): void {
    clearTimer();
    emitPending();
  }

  function scheduleFlush(): void {
    if (timer !== null) {
      return;
    }

    const elapsed = now() - lastEmitAt;
    const delay = Math.max(0, throttleMs - elapsed);
    timer = schedule(() => {
      timer = null;
      emitPending();
    }, delay);
  }

  function onProgress(progress: ScanArchiveProgress): void {
    pending = progress;
    const key = progressKey(progress);
    const keyChanged = lastEmitKey !== key;

    if (keyChanged) {
      flush();
      return;
    }

    const elapsed = now() - lastEmitAt;
    if (elapsed >= throttleMs) {
      flush();
      return;
    }

    scheduleFlush();
  }

  function dispose(): void {
    clearTimer();
    pending = null;
  }

  return { dispose, flush, onProgress };
}
