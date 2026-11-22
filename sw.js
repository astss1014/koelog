// アプリ本体と文字起こしの部品を保存して、オフラインでも開けるようにする
const VERSION = 11;
const CACHE_NAME = 'koelog-v' + VERSION;
const ASSETS = ['./', './index.html', './style.css', './app.js', './worker.js', './recorder-worklet.js', './manifest.json', './icon.svg',
  './vendor/transformers.min.js', './vendor/ort-wasm-simd-threaded.jsep.mjs', './vendor/ort-wasm-simd-threaded.jsep.wasm'];
// 画面と同じセキュリティ設定を、文字起こし担当（Worker）にも付ける
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

// 複数スレッドでの処理に必要な「クロスオリジン分離」の設定を付ける
function isolate(res) {
  if (!res || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', CSP);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
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
  if (!sameApp) return; // AIのファイルはライブラリ側が保存する
  if (url.pathname.includes('/vendor/')) {
    // 同梱ライブラリは版が変わらないので、保存分を優先（起動のたびに通信しない）
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
        return res;
      })).then(isolate)
    );
    return;
  }
  // 本体は新しい版を優先し、通信できないときは保存分を使う
  // （ブラウザの一時保存に残った古いファイルと新しいファイルが混ざらないよう、毎回サーバーに確認する）
  event.respondWith(
    fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); }
      return isolate(res);
    }).catch(() => caches.match(req).then((hit) => (hit ? isolate(hit) : Response.error())))
  );
});
