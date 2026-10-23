import {
  type EngineEvent,
  EngineEventSchema,
  type EngineInput,
  type EngineMethodName,
  EngineMethods,
  type EngineOutput,
  type RootId,
} from "@latch-works/glazier-core/contract";

import type { GlazierBridge } from "../../shared/bridge";
import {
  CallResultSchema,
  type EmptyHoldingResult,
  EmptyHoldingResultSchema,
  JsonSchema,
} from "../../shared/messages";

function requireBridge(): GlazierBridge {
  const bridge = window.glazier;

  if (!bridge) {
    throw new Error("The Glazier desktop bridge is unavailable.");
  }

  return bridge;
}

/** Calls an engine method and parses its result with the contract; rejects with the engine's message. */
export async function call<M extends EngineMethodName>(
  method: M,
  input: EngineInput<M>,
): Promise<EngineOutput<M>> {
  const result = CallResultSchema.parse(
    await requireBridge().call(method, JsonSchema.parse(input)),
  );

  if (!result.ok) {
    throw new Error(result.message);
  }

  // SAFETY: `EngineMethods[method].output` is the schema `EngineOutput<M>` is inferred from.
  return EngineMethods[method].output.parse(result.value) as EngineOutput<M>;
}

export function onEngineEvent(listener: (event: EngineEvent) => void): () => void {
  return requireBridge().onEvent((raw) => {
    const parsed = EngineEventSchema.safeParse(raw);

    if (parsed.success) {
      listener(parsed.data);
    }
  });
}

export const desktop = {
  pickRoot: () => requireBridge().pickRoot(),
  pickFolder: () => requireBridge().pickFolder(),
  reveal: (filePath: string) => requireBridge().reveal(filePath),
  open: (filePath: string) => requireBridge().open(filePath),
  quickLook: (filePath: string) => requireBridge().quickLook(filePath),
  emptyHolding: async (rootId: RootId): Promise<EmptyHoldingResult> =>
    EmptyHoldingResultSchema.parse(await requireBridge().emptyHolding(rootId)),
};

export function mediaUrl(filePath: string): string {
  return `glazier-media://file/?path=${encodeURIComponent(filePath)}`;
}

export function thumbnailUrl(filePath: string, size = 256): string {
  return `glazier-media://thumb/?path=${encodeURIComponent(filePath)}&size=${size}`;
}
