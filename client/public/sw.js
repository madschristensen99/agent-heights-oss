/**
 * Agent Heights Service Worker
 * Cache-first strategy for static assets (images, fonts, JSON, tilemaps).
 * Stale-while-revalidate for JS/CSS bundles.
 * Network-only for API calls and WebSocket.
 */

const CACHE_VERSION = "ah-v1";
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const BUNDLE_CACHE = `${CACHE_VERSION}-bundles`;

const ASSET_PREFIXES = [
  "/assets/",
  "/fonts/",
];

const BUNDLE_EXTENSIONS = [".js", ".css", ".woff2", ".ttf"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) =>
      cache.addAll([
        "/assets/atlases/ai-tiles-atlas.webp?v=277",
        "/assets/atlases/ai-sprites-atlas.webp?v=277",
        "/assets/atlases/ai-hair-atlas.webp?v=277",
      ]).catch(() => {})
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Skip cross-origin requests (API calls, WebSocket, Supabase, etc.)
  if (url.origin !== self.location.origin) return;

  // Skip API calls
  if (url.pathname.startsWith("/api/")) return;

  // Check if this is a static asset
  const isAsset = ASSET_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  const isBundle = BUNDLE_EXTENSIONS.some((ext) => url.pathname.endsWith(ext));
  const isHtml = url.pathname === "/" || url.pathname.endsWith(".html");

  if (isAsset) {
    // Cache-first for assets (images, fonts, tilemaps, atlases, JSON metadata)
    event.respondWith(
      caches.match(req).then((cached) => {
        if (cached) {
          // Update cache in background
          fetch(req).then((res) => {
            if (res.ok) {
              caches.open(ASSET_CACHE).then((cache) => cache.put(req, res.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        // Not in cache — fetch, cache, and return
        return fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        });
      })
    );
  } else if (isBundle) {
    // Stale-while-revalidate for JS/CSS bundles
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(BUNDLE_CACHE).then((cache) => cache.put(req, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;
      })
    );
  } else if (isHtml) {
    // Network-first for HTML documents (always get the latest)
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(BUNDLE_CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
  // Everything else: let the browser handle it normally
});
