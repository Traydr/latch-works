import { createMiddleware, createStart } from "@tanstack/react-start";
import { applySecurityHeadersToResponse } from "./server/security-headers";

/**
 * Picks up maintenance jobs a previous process left pending or running. The
 * worker resumes once per process. Requests never wait on it or fail with it:
 * a database outage is logged and retried on the next request, and
 * `/api/health` keeps answering.
 */
const resumeMaintenanceJobsMiddleware = createMiddleware().server(({ next }) => {
  const resume = async () => {
    try {
      const { resumePendingMaintenanceJobs } = await import("./server/management/cleanup-worker");
      await resumePendingMaintenanceJobs();
    } catch (error) {
      console.error("[pane-view] Unable to resume maintenance jobs", error);
    }
  };

  void resume();

  return next();
});

const securityHeadersMiddleware = createMiddleware().server(async ({ next, pathname }) => {
  const result = await next();

  if (result instanceof Response) {
    return applySecurityHeadersToResponse(result, pathname);
  }

  if (result.response instanceof Response) {
    applySecurityHeadersToResponse(result.response, pathname);
  }

  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [securityHeadersMiddleware, resumeMaintenanceJobsMiddleware],
}));
