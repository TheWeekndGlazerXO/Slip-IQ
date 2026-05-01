const CACHE_NAME = 'slipiq-v1';
const STATIC_ASSETS = [
  '/home.html', '/leagues.html', '/mobile.css', '/mobile-nav.js',
  '/config.js',
  'https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Cache-first for static assets
  if (e.request.method === 'GET' && (
    url.pathname.endsWith('.css') || url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.html') || url.hostname.includes('fonts.googleapis')
  )) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    })));
    return;
  }
  // Network-first with cache fallback for API calls
  if (url.pathname.startsWith('/predictions') || url.pathname.startsWith('/standings')) {
    e.respondWith(fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match(e.request)));
  }
});