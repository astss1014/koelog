// アプリ本体と、文字起こしの部品（CDN）を保存してオフラインでも開けるようにする
const CACHE_NAME = 'koelog-v5';
const ASSETS = ['./', './index.html', './style.css', './app.js', './worker.js', './recorder-worklet.js', './manifest.json', './icon.svg'];

// 複数スレッドでの処理に必要な「クロスオリジン分離」の設定を付ける
function isolate(res) {
  if (!res || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
        return isolate(res);
      }).catch(() => caches.match(req).then((hit) => (hit ? isolate(hit) : Response.error())))
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
