/**
 * Every message that crosses a process boundary in the desktop app, as zod schemas: main ↔ the
 * engine utility process, main ↔ the AVIF workers, main ↔ the hidden transcoder window, and the
 * renderer's IPC. Each receiver parses with these.
 */
import {
  EncoderCapabilitiesSchema,
  EngineEventSchema,
  EngineMethodNameSchema,
  RootIdSchema,
  StillEncodeRequestSchema,
  StillEncodeResultSchema,
  TranscodeJobSchema,
} from "@latch-works/glazier-core/contract";
import { z } from "zod";

export const JsonSchema = z.json();

export type Json = z.infer<typeof JsonSchema>;

const RequestId = z.number().int().nonnegative();

/** main → engine */
export const EngineInboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call"),
    id: RequestId,
    method: EngineMethodNameSchema,
    input: JsonSchema,
  }),
  z.object({ type: z.literal("encoded"), id: RequestId, result: StillEncodeResultSchema }),
  z.object({ type: z.literal("encode-failed"), id: RequestId, message: z.string() }),
  z.object({ type: z.literal("transcoded"), id: RequestId }),
  z.object({ type: z.literal("transcode-failed"), id: RequestId, message: z.string() }),
  z.object({ type: z.literal("transcode-progress"), id: RequestId, ratio: z.number() }),
  z.object({
    type: z.literal("capabilities"),
    video: EncoderCapabilitiesSchema.shape.video,
    aac: z.boolean(),
  }),
]);

export type EngineInbound = z.infer<typeof EngineInboundSchema>;

/** engine → main */
export const EngineOutboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("result"), id: RequestId, value: JsonSchema }),
  z.object({ type: z.literal("error"), id: RequestId, message: z.string() }),
  z.object({ type: z.literal("event"), event: EngineEventSchema }),
  z.object({ type: z.literal("encode"), id: RequestId, request: StillEncodeRequestSchema }),
  z.object({ type: z.literal("cancel-encode"), id: RequestId }),
  z.object({ type: z.literal("transcode"), id: RequestId, job: TranscodeJobSchema }),
  z.object({ type: z.literal("cancel-transcode"), id: RequestId }),
]);

export type EngineOutbound = z.infer<typeof EngineOutboundSchema>;

/** main → AVIF worker */
export const WorkerInboundSchema = z.object({
  type: z.literal("encode"),
  id: RequestId,
  request: StillEncodeRequestSchema,
});

export type WorkerInbound = z.infer<typeof WorkerInboundSchema>;

/** AVIF worker → main */
export const WorkerOutboundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("encoded"), id: RequestId, result: StillEncodeResultSchema }),
  z.object({ type: z.literal("encode-failed"), id: RequestId, message: z.string() }),
]);

export type WorkerOutbound = z.infer<typeof WorkerOutboundSchema>;

/** main → transcoder window */
export const TranscoderJobMessageSchema = z.object({ id: RequestId, job: TranscodeJobSchema });

export type TranscoderJobMessage = z.infer<typeof TranscoderJobMessageSchema>;

/** transcoder window → main */
export const TranscoderOutboundSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("capabilities"),
    video: EncoderCapabilitiesSchema.shape.video,
    aac: z.boolean(),
  }),
  z.object({ type: z.literal("progress"), id: RequestId, ratio: z.number() }),
  z.object({ type: z.literal("done"), id: RequestId }),
  z.object({ type: z.literal("failed"), id: RequestId, message: z.string() }),
]);

export type TranscoderOutbound = z.infer<typeof TranscoderOutboundSchema>;

export const TranscoderChannels = {
  job: "glazier-transcoder:job",
  cancel: "glazier-transcoder:cancel",
  outbound: "glazier-transcoder:outbound",
  allow: "glazier-transcoder:allow",
} as const;

/** renderer → main */
export const RendererChannels = {
  call: "glazier:call",
  pickRoot: "glazier:pick-root",
  pickFolder: "glazier:pick-folder",
  reveal: "glazier:reveal",
  open: "glazier:open",
  quickLook: "glazier:quick-look",
  emptyHolding: "glazier:empty-holding",
  event: "glazier:event",
} as const;

export const CallResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: JsonSchema }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

export type CallResult = z.infer<typeof CallResultSchema>;

export const EmptyHoldingResultSchema = z.object({
  emptied: z.number().int(),
  failed: z.array(z.string()),
});

export type EmptyHoldingResult = z.infer<typeof EmptyHoldingResultSchema>;

export const PathArgSchema = z.string().min(1);

export const RootArgSchema = RootIdSchema;
