// Service Worker fuer Italienisch Trainer PWA
// Zweck: Installierbarkeit (Voraussetzung fuer "Standalone"-Start ohne Browser-Chrome)
// und Offline-Verfuegbarkeit der Grundoberflaeche (NICHT der Lerninhalte -
// Lerninhalte kommen live vom Webhook, siehe AGENTS.md-Vorgabe getrennter
// Betriebsarten Tag/Nacht).

const CACHE_NAME = "it-trainer-shell-v1";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Webhook-Aufrufe NIE aus dem Cache bedienen - das ist Live-Verkehr.
  if (event.request.method !== "GET") {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => cached);
    })
  );
});
