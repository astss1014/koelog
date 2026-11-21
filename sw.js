// アプリ本体と、文字起こしの部品（CDN）を保存してオフラインでも開けるようにする
const CACHE_NAME = 'koelog-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './worker.js', './recorder-worklet.js', './manifest.json', './icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('koelog-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameApp = url.origin === self.location.origin && url.pathname.startsWith(new URL('./', self.location).pathname);
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameApp && !cdn) return; // AIのファイルはライブラリ側が保存する
  if (sameApp) {
    // 本体は新しい版を優先し、通信できないときは保存分を使う
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
  } else {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
