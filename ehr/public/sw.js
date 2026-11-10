/* Clinic Ready EHR service worker.
 * Makes the EHR installable as a home-screen app. It deliberately caches NOTHING with patient information:
 * every request goes to the network, and only a static "you're offline" page (no PHI) is stored, shown when
 * the phone has no connection. */
"use strict";
const OFFLINE = "/ehr/static/offline.html";
const CACHE = "cr-offline-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return; // let the browser handle everything else normally
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});
