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

/** renderer → main, and the two main → renderer channels (`event`, `command`) */
export const RendererChannels = {
  call: "glazier:call",
  listFolder: "glazier:list-folder",
  folderPlaces: "glazier:folder-places",
  reveal: "glazier:reveal",
  open: "glazier:open",
  quickLook: "glazier:quick-look",
  emptyHolding: "glazier:empty-holding",
  showMenu: "glazier:show-menu",
  confirm: "glazier:confirm",
  event: "glazier:event",
  command: "glazier:command",
} as const;

/** What the app menu asks the renderer to do; the renderer owns every command's behaviour. */
export const AppCommandSchema = z.enum([
  "add-root",
  "rescan",
  "undo",
  "select-all",
  "find",
  "settings",
  "shortcuts",
  "toggle-sidebar",
  "view:overview",
  "view:duplicates",
  "view:convert",
  "view:cleanup",
  "view:library",
  "view:history",
  "view:holding",
]);

export type AppCommand = z.infer<typeof AppCommandSchema>;

const MenuSeparatorSchema = z.object({ type: z.literal("separator") });

const MenuItemSchema = z.object({
  type: z.literal("item"),
  /** What the menu resolves with when this item is chosen. */
  id: z.string(),
  label: z.string(),
  enabled: z.boolean().optional(),
  checked: z.boolean().optional(),
  /** Shown beside the label only; the renderer handles the key itself. */
  accelerator: z.string().optional(),
  sublabel: z.string().optional(),
});

/** A native context menu entry. Submenus go one level deep. */
export const MenuEntrySchema = z.discriminatedUnion("type", [
  MenuSeparatorSchema,
  MenuItemSchema,
  z.object({
    type: z.literal("submenu"),
    label: z.string(),
    enabled: z.boolean().optional(),
    items: z.array(z.discriminatedUnion("type", [MenuSeparatorSchema, MenuItemSchema])),
  }),
]);

export type MenuEntry = z.infer<typeof MenuEntrySchema>;

/** A native confirmation sheet, for the few actions Glazier cannot undo. */
export const ConfirmRequestSchema = z.object({
  message: z.string(),
  detail: z.string().optional(),
  confirmLabel: z.string(),
  destructive: z.boolean().optional(),
});

export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

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

/** One folder under the folder being browsed. */
const FolderEntrySchema = z.object({ name: z.string(), path: z.string() });

/** The folders inside one folder, for the in-app folder picker; hidden and system folders left out. */
export const FolderListingSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    path: z.string(),
    parent: z.string().nullable(),
    folders: z.array(FolderEntrySchema),
  }),
  z.object({
    ok: z.literal(false),
    path: z.string(),
    parent: z.string().nullable(),
    message: z.string(),
  }),
]);

export type FolderListing = z.infer<typeof FolderListingSchema>;

const FolderPlaceSchema = z.object({
  kind: z.enum(["home", "desktop", "documents", "downloads", "pictures", "videos", "volume"]),
  label: z.string(),
  path: z.string(),
});

export type FolderPlace = z.infer<typeof FolderPlaceSchema>;

/** Where the folder picker can start: the home folder, its usual folders, and mounted drives. */
export const FolderPlacesSchema = z.object({
  home: z.string(),
  /** `path.sep`, so the picker splits a typed path the way this platform writes it. */
  separator: z.string(),
  places: z.array(FolderPlaceSchema),
  volumes: z.array(FolderPlaceSchema),
});

export type FolderPlaces = z.infer<typeof FolderPlacesSchema>;
