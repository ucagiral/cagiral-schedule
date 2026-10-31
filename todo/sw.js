// Service worker for Reminders: offline shell, and the push handler.
// A push carries no payload (see todo-worker/webpush.mjs); the notification text is built
// here from the tasks the app mirrored into IndexedDB. iOS requires every push to show a
// notification, so one is always shown, even if the local list looks empty.
importScripts("engine.js");
const CACHE = "todo-v1";
const OWN_PREFIX = "todo-";
const SHELL = [".", "index.html", "engine.js", "manifest.webmanifest", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })))))
    .then(() => self.skipWaiting()));
});

// Only this app's caches: the origin's Cache Storage is shared with nothing else here, but
// the prefix check keeps that true if another app is ever served from the same host.
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith(OWN_PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(req).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(req).then((m) => m || caches.match("index.html"))));
});

function readTasks() {
  return new Promise((resolve) => {
    const open = indexedDB.open("todo-db", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => resolve([]);
    open.onsuccess = () => {
      try {
        const r = open.result.transaction("kv").objectStore("kv").get("tasks");
        r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : []);
        r.onerror = () => resolve([]);
      } catch (err) { resolve([]); }
    };
  });
}

self.addEventListener("push", (e) => {
  e.waitUntil(readTasks().then((tasks) => {
    const now = Date.now();
    const due = TodoEngine.sortOpen(tasks.filter((t) => TodoEngine.isOverdue(t, now)));
    const text = due.length ? TodoEngine.notificationText(due)
      : { title: "Reminders", body: "You have open tasks." };
    return self.registration.showNotification(text.title, {
      body: text.body, tag: "todo-due", renotify: true,
      icon: "icon-192.png", badge: "icon-192.png"
    });
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => {
    for (const c of cs) if ("focus" in c) return c.focus();
    return self.clients.openWindow(".");
  }));
});
