import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  claimDerivativeJobs,
  completeDerivativeJob,
  type DerivativeJob,
  failDerivativeJob,
} from "./derivative-queue";

const DEFAULT_CLAIM_LIMIT = 5;
const MAX_CLAIM_LIMIT = 50;

export const claimRequestSchema = z.object({
  limit: z.number().int().positive().max(MAX_CLAIM_LIMIT).optional(),
});

export const completeRequestSchema = z.object({
  height: z.number().int().nonnegative(),
  mediaObjectId: z.string().uuid(),
  objectKey: z.string().min(1),
  processingToken: z.string().min(1),
  size: z.number().int().positive(),
  width: z.number().int().nonnegative(),
});

export const failRequestSchema = z.object({
  error: z.string().min(1).max(2000),
  mediaObjectId: z.string().uuid(),
  processingToken: z.string().min(1),
  size: z.number().int().positive(),
});

export interface ClaimResponse {
  jobs: DerivativeJob[];
  processingToken: string;
}

/**
 * Issues a fresh lease token and claims a batch of pending derivative jobs for
 * the optimizer to process.
 */
export async function claimOptimizerJobs(
  input: z.infer<typeof claimRequestSchema>,
): Promise<ClaimResponse> {
  const processingToken = randomUUID();
  const jobs = await claimDerivativeJobs({
    limit: input.limit ?? DEFAULT_CLAIM_LIMIT,
    processingToken,
  });

  return { jobs, processingToken };
}

export async function completeOptimizerJob(
  input: z.infer<typeof completeRequestSchema>,
): Promise<{ matched: boolean }> {
  const matched = await completeDerivativeJob(input);
  return { matched };
}

export async function failOptimizerJob(input: z.infer<typeof failRequestSchema>) {
  return failDerivativeJob(input);
}
