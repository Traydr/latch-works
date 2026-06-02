import type { z } from 'zod';

import {
  createTypeGuard,
  type ThumbnailDebugOptionsSchema,
  type ThumbnailDiagnosticsSnapshotSchema,
  type ThumbnailJobKindSchema,
  type ThumbnailJobPrioritySchema,
  type ThumbnailJobRequestSchema,
  type ThumbnailPerformanceSnapshotSchema,
  type ThumbnailTimingAggregateSchema,
  type ThumbnailWorkerCapabilitiesSchema,
  ThumbnailWorkerEventSchema,
  type ThumbnailWorkerJobResultSchema,
  type ThumbnailWorkerRequestSchema,
  ThumbnailWorkerResponseSchema,
} from './contracts';

export type ThumbnailJobKind = z.infer<typeof ThumbnailJobKindSchema>;
export type ThumbnailJobPriority = z.infer<typeof ThumbnailJobPrioritySchema>;
export type ThumbnailDebugOptions = z.infer<typeof ThumbnailDebugOptionsSchema>;
export type ThumbnailJobRequest = z.infer<typeof ThumbnailJobRequestSchema>;
export type ThumbnailWorkerCapabilities = z.infer<typeof ThumbnailWorkerCapabilitiesSchema>;
export type ThumbnailTimingAggregate = z.infer<typeof ThumbnailTimingAggregateSchema>;
export type ThumbnailPerformanceSnapshot = z.infer<typeof ThumbnailPerformanceSnapshotSchema>;
export type ThumbnailDiagnosticsSnapshot = z.infer<typeof ThumbnailDiagnosticsSnapshotSchema>;
export type ThumbnailWorkerJobResult = z.infer<typeof ThumbnailWorkerJobResultSchema>;
export type ThumbnailWorkerRequest = z.infer<typeof ThumbnailWorkerRequestSchema>;
export type ThumbnailWorkerResponse = z.infer<typeof ThumbnailWorkerResponseSchema>;
export type ThumbnailWorkerEvent = z.infer<typeof ThumbnailWorkerEventSchema>;

export const isThumbnailWorkerResponse = createTypeGuard(ThumbnailWorkerResponseSchema);
export const isThumbnailWorkerEvent = createTypeGuard(ThumbnailWorkerEventSchema);
