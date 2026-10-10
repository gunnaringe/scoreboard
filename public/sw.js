// Network-first for app files so a deploy is picked up on the next load, with
// the cache as an offline fallback. The API is never cached. Every non-API
// navigation is the same index.html (client-side routing).
const CACHE = 'scoreboard-v2';
const PRECACHE = ['/', '/styles.css', '/theme.js', '/i18n.js', '/rating.js', '/qrcodegen.js', '/app.js',
    '/manifest.webmanifest', '/icons/icon.svg', '/fonts/vt323-latin.woff2', '/fonts/vt323-latin-ext.woff2'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    const key = e.request.mode === 'navigate' ? '/' : url.pathname;
    e.respondWith(fetch(e.request).then((res) => {
        if (res.ok && !res.redirected) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
    }).catch(() => caches.match(key).then((hit) => hit || Response.error())));
});
