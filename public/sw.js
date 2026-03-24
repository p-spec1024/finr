// FINR Service Worker — never intercept auth callbacks
const CACHE = 'finr-v2';

self.addEventListener('install', e => {
  e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // NEVER intercept these — let them go straight to server
  if (url.pathname.startsWith('/callback') ||
      url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/api/')) {
    return; // pass through, no caching
  }

  // For everything else, network first
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
