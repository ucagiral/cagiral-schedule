// Service worker for the wardrobe app, scoped to /wardrobe/ so it can't touch
// the schedule app sitting next to it. Scope is not the whole story though: both
// apps share one Cache Storage, which the activate handler below has to respect.
//
// Same reasoning as the schedule's worker: the shell is cached so the app opens
// instantly and opens at all with no signal, but wardrobe.json is never cached —
// a stale wardrobe would quietly suggest clothes that are in the wash. Item
// photos are cached hard, because a sticker at a given path never changes.
const CACHE = "wardrobe-v3";

const SHELL = [
  ".",
  "index.html",
  "engine.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

// Drop this app's older caches -- and ONLY this app's. caches.keys() returns every
// cache on the origin, and the schedule app next door has its own; an unfiltered
// sweep here would delete the schedule's offline copy the first time the wardrobe
// is ever opened.
const OWN_CACHE_PREFIX = "wardrobe-";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith(OWN_CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Wardrobe data, the demo manifest and the schedule are always live.
  if (/wardrobe\.json|demo\.json|claudeAgent\.json/.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("index.html").then((m) => m || caches.match(".")))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // An item photo at a given path is immutable, so there is nothing to
        // revalidate; everything else gets refreshed quietly in the background.
        if (!/\/items\/|\/demo\//.test(url.pathname)) {
          fetch(req).then((res) => {
            if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
          }).catch(() => {});
        }
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
