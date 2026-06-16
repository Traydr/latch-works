import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defineEventHandler, getHeader, getMethod, getRequestURL } from "nitro/h3";

const dynamicPathPrefixes = ["/_serverFn", "/api", "/internal", "/cdn/v1", "/assets"] as const;
const staticFilePattern = /\/[^/]+\.[^/]+$/;
const shellPath = join(process.cwd(), ".output", "public", "_shell.html");

export default defineEventHandler(async (event) => {
  const method = getMethod(event);
  if (method !== "GET" && method !== "HEAD") {
    return;
  }

  const pathname = getRequestURL(event).pathname;
  if (!shouldServeSpaShell(pathname, getHeader(event, "accept"))) {
    return;
  }

  if (!existsSync(shellPath)) {
    return;
  }

  const headers = {
    "Cache-Control": "no-cache",
    "Content-Type": "text/html; charset=utf-8",
  };

  if (method === "HEAD") {
    return new Response(null, { headers });
  }

  return new Response(await readFile(shellPath, "utf8"), { headers });
});

function shouldServeSpaShell(pathname: string, accept: string | undefined): boolean {
  if (
    dynamicPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  ) {
    return false;
  }

  if (pathname !== "/_shell.html" && staticFilePattern.test(pathname)) {
    return false;
  }

  return !accept || accept.includes("text/html") || accept.includes("*/*");
}
