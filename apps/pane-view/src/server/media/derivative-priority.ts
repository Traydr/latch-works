import { PREVIEW_DERIVATIVE_SIZE } from "@latch-works/media-delivery";

export type DerivativeQueueSource = "prewarm" | "on-demand";
export type DerivativeQueueVariant = "thumbnail" | "preview";

export interface DerivativeQueueIntent {
  priorityAt?: Date;
  source: DerivativeQueueSource;
  variant: DerivativeQueueVariant;
}

export function resolveDerivativeQueuePriority(intent: DerivativeQueueIntent): number {
  if (intent.source === "on-demand") {
    return intent.variant === "preview" ? 300 : 200;
  }

  return intent.variant === "preview" ? 100 : 0;
}

export function derivativeQueueVariantForRequestedSize(size: number): DerivativeQueueVariant {
  return size === PREVIEW_DERIVATIVE_SIZE ? "preview" : "thumbnail";
}
