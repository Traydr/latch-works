import type { z } from 'zod';

import type {
  CatalogWorkerEventSchema,
  CatalogWorkerRequestSchema,
  CatalogWorkerResponseSchema,
} from './contracts';

export type CatalogWorkerRequest = z.infer<typeof CatalogWorkerRequestSchema>;
export type CatalogWorkerResponse = z.infer<typeof CatalogWorkerResponseSchema>;
export type CatalogWorkerEvent = z.infer<typeof CatalogWorkerEventSchema>;
