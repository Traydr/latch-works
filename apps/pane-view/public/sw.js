/*
 * Pane View's service worker (plan 066, phase 4). It makes the installed app start fast and shows
 * an offline page instead of a blank screen. It caches only public, versioned files, never media
 * and never anything that carries the session:
 *
 *   /assets/*             cache-first: hashed names, so a cached copy is never stale
 *   icons, the manifest,  stale-while-revalidate: small and public
 *   the offline page
 *   page navigations      network-first, then the offline page; never cached
 *   everything else       not intercepted: /api/*, /_serverFn/*, other origins (Shutter, S3),
 *                         Range requests (video) and anything that is not a GET
 *
 * The page registers /sw.js?v=<build id>. Each deploy registers a new URL, so the browser
 * installs a new worker with its own caches, and the old caches go when it activates. It waits
 * until the page asks it to take over (the "Update available" toast), so no page ever runs
 * against another version's assets.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") ?? "dev";
const CACHE_PREFIX = "pane-view-";
const ASSET_CACHE = `${CACHE_PREFIX}assets-${VERSION}`;
const STATIC_CACHE = `${CACHE_PREFIX}static-${VERSION}`;
const OFFLINE_URL = "/offline.html";

const STATIC_PATHS = new Set([
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.svg",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

/** The offline page and what it shows, cached at install so it works with no connection. */
const OFFLINE_PAGE_FILES = [OFFLINE_URL, "/favicon.svg"];

const NEVER_INTERCEPTED_PREFIXES = ["/api/", "/_serverFn/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        cache.addAll(OFFLINE_PAGE_FILES.map((path) => new Request(path, { cache: "reload" }))),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const current = new Set([ASSET_CACHE, STATIC_CACHE]);
      const names = await caches.keys();

      await Promise.all(
        names
          .filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  if (NEVER_INTERCEPTED_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  if (request.mode === "navigate") {
    event.respondWith(networkThenOffline(request));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (STATIC_PATHS.has(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

/** A page always comes from the server: it is rendered per session. Offline, the offline page. */
async function networkThenOffline(request) {
  try {
    return await fetch(request);
  } catch {
    return (await caches.match(OFFLINE_URL)) ?? Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);

  if (cached) return cached;

  const response = await fetch(request);

  if (isCacheable(response)) await cache.put(request, response.clone());

  return response;
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);

  const refresh = fetch(request).then(async (response) => {
    if (isCacheable(response)) await cache.put(request, response.clone());

    return response;
  });

  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));

    return cached;
  }

  return refresh;
}

/** Only a complete, same-origin answer: never a redirect, an error or an opaque response. */
function isCacheable(response) {
  return response.ok && response.status === 200 && response.type === "basic";
}
