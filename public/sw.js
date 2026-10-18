// Service worker minimo: serve a rendere Helios installabile come app sul desktop (PWA).
// Non mette in cache i dati delle carte: solo la pagina, così all'avvio senza rete compare almeno il client.
const CACHE = "helios-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || caches.match("./")))
  );
});
