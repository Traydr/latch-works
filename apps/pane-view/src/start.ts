import { createMiddleware, createStart } from "@tanstack/react-start";
import { applySecurityHeadersToResponse } from "./server/security-headers";

const securityHeadersMiddleware = createMiddleware().server(async ({ next, pathname }) => {
  const { resumePendingMaintenanceJobs } = await import("./server/management/cleanup-worker");
  await resumePendingMaintenanceJobs();
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
  requestMiddleware: [securityHeadersMiddleware],
}));
