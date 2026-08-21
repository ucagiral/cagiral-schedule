// Service worker: makes the app open instantly and still open with no signal.
//
// Deliberately does NOT cache schedule data. claudeAgent.json, schedule.ics and every
// GitHub API call go straight to the network — a stale schedule is worse than no schedule.
// The app keeps its own last-known copy in localStorage for the offline case.
//
// This origin serves two apps -- the schedule here and the wardrobe under /wardrobe/ --
// which means they share one Cache Storage and one scope tree. Both facts bite:
// see the activate and fetch handlers below.
//
// Bump CACHE when index.html / sw.js / icons change, so clients pick up the new shell.
const CACHE = "cagiral-schedule-v7";

const SHELL = [
  ".",
  "index.html",
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
// cache on the origin, including the wardrobe's, so an unfiltered sweep here would
// delete the other app's offline copy every time this worker updates.
const OWN_CACHE_PREFIX = "cagiral-schedule-";

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

  // Never intercept data or API traffic.
  if (url.origin !== self.location.origin) return;
  if (/claudeAgent\.json|schedule\.ics/.test(url.pathname)) return;

  // The wardrobe app sits inside this worker's scope but is not this worker's
  // business. Without this, the very first visit to it -- before its own worker
  // exists -- is served here, and the navigation handler below would cache the
  // wardrobe's page under this app's "index.html" key, so opening the schedule
  // offline afterwards would show the wardrobe.
  if (url.pathname.includes("/wardrobe/")) return;

  // Navigations: prefer the network so app updates land, fall back to cache offline.
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
