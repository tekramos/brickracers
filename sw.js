// Offline cache: game files first from the network (so updates show up), falling back to the cache.
const CACHE = 'brickracers-v1';
const FILES = ['./', 'index.html', 'pad.html', 'js/main.js', 'js/race.js', 'js/track.js', 'js/models.js', 'js/padhost.js', 'js/audio.js', 'manifest.webmanifest', 'pad.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.protocol.startsWith('ws')) return;
  // three.js and fonts from CDNs: cache first (they are versioned)
  if (u.origin !== location.origin){
    if (!/cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.host)) return;
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(r => r || fetch(e.request).then(n => { if (n.ok) c.put(e.request, n.clone()); return n; }))));
    return;
  }
  e.respondWith(fetch(e.request).then(n => { const c = n.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return n; }).catch(() => caches.match(e.request)));
});
