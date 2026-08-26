// Service worker for the cell stocks app, scoped to /cellstocks/.
//
// Scope is not the whole story: this host serves other apps from the same origin,
// and one origin means one Cache Storage shared between all of them. That is why
// the activate handler below sweeps only caches carrying this app's own prefix --
// an unfiltered sweep would delete a neighbour's offline copy.
//
// The shell is cached so the app opens instantly, and opens at all with no signal.
// cellstocks.json is never cached: a stale inventory is worse than no inventory,
// because it sends someone to a slot that was emptied this morning. The app keeps
// its own last-known copy in localStorage for the offline case, and says out loud
// that it is offline when it falls back to it.
//
// Bump CACHE when index.html / engine.js / xlsx.js / icons change.
const CACHE = "cellstocks-v1";

const SHELL = [
  ".",
  "index.html",
  "engine.js",
  "xlsx.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Individually, so one missing file can't fail the whole install.
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
      .then(() => self.skipWaiting())
  );
});

// Drop this app's older caches -- and ONLY this app's. caches.keys() returns every
// cache on the origin, including its neighbours'; an unfiltered sweep here would
// delete their offline copies the first time this app is opened.
const OWN_CACHE_PREFIX = "cellstocks-";

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

  // The inventory and the workbook generated from it are always live. Anything
  // outside this app's own directory is none of this worker's business.
  if (!url.pathname.includes("/cellstocks/")) return;
  if (/cellstocks\.json|cell-stocks\.xlsx/.test(url.pathname)) return;

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

  // Static assets: cache first, refresh in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
        }).catch(() => {});
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
