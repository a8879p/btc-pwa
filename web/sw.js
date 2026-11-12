// Service worker: оболочка приложения - из кэша (обновляется в фоне), данные - сначала сеть, при её отсутствии кэш.
// Если меняете app.js / style.css / index.html - достаточно загрузить заново: оболочка обновится при следующем открытии.
// Поднимайте V, только если нужно принудительно сбросить кэш у всех.
const V = "v1";
const SHELL_CACHE = "shell-" + V;
const DATA_CACHE = "data-v1";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "fonts/geologica-cyrillic-wght-normal.woff2", "fonts/geologica-latin-wght-normal.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL_CACHE && k !== DATA_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(url.pathname.includes("/data/") ? networkFirst(req) : staleWhileRevalidate(e, req));
});

async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req, { cache: "no-store" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || Response.error();
  }
}

async function staleWhileRevalidate(e, req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req, { cache: "no-cache" })
    .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (hit) { e.waitUntil(net); return hit; }
  const res = await net;
  if (res) return res;
  return req.mode === "navigate" ? (await cache.match("index.html")) || Response.error() : Response.error();
}
