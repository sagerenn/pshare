/*
 * pshare service worker. pshare is a static site, so the SW caches the app
 * shell and static assets for offline use. Share *content* (text, files,
 * media) is fetched live from OpenList and is never cached — shares are
 * temporary and must reflect their current (possibly expired) state.
 *
 * All paths are derived from this script's own URL, so the same SW works at
 * the root and under a sub-path (e.g. GitHub Pages /pshare/) without a
 * rebuild: serving /pshare/sw.js means the app shell lives at /pshare/.
 */
const CACHE = "pshare-v1";
// "/pshare/sw.js" -> "/pshare/"; "/sw.js" -> "/"
const BASE = self.location.pathname.replace(/sw\.js$/, "");
const APP_SHELL = [BASE, `${BASE}manifest.webmanifest`, `${BASE}icon-192.png`, `${BASE}icon-512.png`];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Never cache cross-origin requests (OpenList API + media) — shares are
  // temporary and must always be fetched live.
  if (url.origin !== self.location.origin) return;

  // Navigation requests: network-first, fall back to cached app shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match(BASE))),
    );
    return;
  }

  // Same-origin static assets: cache-first.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      });
    }),
  );
});
