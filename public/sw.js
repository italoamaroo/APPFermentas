/* Service worker simples: rede primeiro, cache como reserva (app abre mesmo com sinal fraco). */
const CACHE = "almox-v1";
const SHELL = ["app.html", "index.html", "css/style.css", "js/core.js", "js/app.js", "js/painel.js",
  "vendor/supabase.js", "vendor/qrcode.js", "vendor/jsQR.js", "icons/icon-192.png", "manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase nunca passa pelo cache
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
