import type { z } from 'zod';

import {
  CatalogWorkerEventSchema,
  type CatalogWorkerRequestSchema,
  CatalogWorkerResponseSchema,
  createTypeGuard,
} from './contracts';

export type CatalogWorkerRequest = z.infer<typeof CatalogWorkerRequestSchema>;
export type CatalogWorkerResponse = z.infer<typeof CatalogWorkerResponseSchema>;
export type CatalogWorkerEvent = z.infer<typeof CatalogWorkerEventSchema>;

export const isCatalogWorkerResponse = createTypeGuard(CatalogWorkerResponseSchema);
export const isCatalogWorkerEvent = createTypeGuard(CatalogWorkerEventSchema);
