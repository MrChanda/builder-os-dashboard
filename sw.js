// BUILDER OS — service worker
// Strategy: precache the static shell so the app opens instantly and works
// offline. API traffic (Google Apps Script) is NEVER cached — those calls go
// straight to the network so data is always live. If you change the shell,
// bump CACHE_VERSION to invalidate old caches.

const CACHE_VERSION = 'builder-os-v2-1';
const SHELL = [
  './',
  './index.html',
  './mobile.html',
  './api.js',
  './manifest.json',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll fails the whole install if one URL 404s; tolerate missing
      // optional assets (e.g. avatars) by adding individually.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs. Anything cross-origin (the Apps Script
  // backend, Google Fonts) or any non-GET (POST logs) bypasses the SW.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((r) => r || caches.match('./mobile.html')))
    );
    return;
  }

  // Static assets: cache-first, then network (and cache the result).
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
