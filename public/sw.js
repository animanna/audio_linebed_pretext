// Lyrebed service worker — hand-rolled, no build step.
// Strategy:
//  - /api/*  → never touched (bridge must stay live; system audio + now-playing)
//  - cross-origin (lrclib, fonts) → passthrough to network
//  - navigations → network-first, fall back to the cached shell when offline
//  - same-origin assets → stale-while-revalidate (robust to Vite's hashed names)
// Bump CACHE to invalidate everything on the next activate.

const CACHE = "lyrebed-shell-v1";
// Resolve everything relative to where the SW is served from, so the app
// works at "/" (dev/preview) and under a subpath (GitHub Pages project site).
const BASE = new URL("./", self.location).pathname;
const CORE = [BASE, BASE + "index.html", BASE + "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // lrclib / google fonts → network
  if (url.pathname.startsWith(BASE + "api/")) return; // bridge endpoints → always live

  // App navigations: try network, fall back to the cached shell offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          caches.match(BASE + "index.html").then((r) => r || caches.match(BASE)),
      ),
    );
    return;
  }

  // Static assets: serve cache immediately, refresh in the background.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then((cached) => {
        const network = fetch(request)
          .then((resp) => {
            // Only cache full, same-origin 200s (skip 206 range chunks for audio).
            if (resp && resp.status === 200 && resp.type === "basic") {
              cache.put(request, resp.clone());
            }
            return resp;
          })
          .catch(() => cached);
        return cached || network;
      }),
    ),
  );
});
