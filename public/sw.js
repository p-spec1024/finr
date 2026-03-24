const CACHE_NAME='finr-v2';
const STATIC=['/','/?from=home-screen','/manifest.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE_NAME).then(c=>c.addAll(STATIC)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k)))));self.clients.claim();});
self.addEventListener('fetch',e=>{
  // Never intercept auth/api/callback
  const url=new URL(e.request.url);
  if(url.pathname.startsWith('/callback')||url.pathname.startsWith('/api/')||url.pathname.startsWith('/auth/')||url.pathname.startsWith('/zerodha/')){
    e.respondWith(fetch(e.request));return;
  }
  // Network-first for HTML
  if(e.request.headers.get('accept')?.includes('text/html')){
    e.respondWith(fetch(e.request).catch(()=>caches.match('/')));return;
  }
  // Cache-first for static assets
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));
});
