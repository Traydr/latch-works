import { z } from "zod";

export const TRIGGER_DOWNLOAD_MESSAGE = "GATHER_BOX_TRIGGER_DOWNLOAD" as const;
export const OPEN_EXTENSION_MESSAGE = "GATHER_BOX_OPEN_EXTENSION" as const;

export const TriggerDownloadMessageSchema = z.object({
  type: z.literal(TRIGGER_DOWNLOAD_MESSAGE),
  target: z.literal("background")
});

export type TriggerDownloadMessage = z.infer<typeof TriggerDownloadMessageSchema>;

export const OpenExtensionMessageSchema = z.object({
  type: z.literal(OPEN_EXTENSION_MESSAGE),
  target: z.literal("background")
});

export type OpenExtensionMessage = z.infer<typeof OpenExtensionMessageSchema>;

export const GatherRuntimeMessageSchema = z.discriminatedUnion("type", [
  TriggerDownloadMessageSchema,
  OpenExtensionMessageSchema
]);

export type GatherRuntimeMessage = z.infer<typeof GatherRuntimeMessageSchema>;
