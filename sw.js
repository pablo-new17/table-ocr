// Service Worker：第一次連線時把所有檔案存進 cache，之後全部從 cache 讀取，斷線也能用。
// 改了任何檔案就把 CACHE_VERSION 加 1，手機才會下載新版。
const CACHE_VERSION = 9;
const CACHE_NAME = `table-ocr-v${CACHE_VERSION}`;

const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'icon.svg',
  'icon-192.png',
  'icon-512.png',
  'js/app.js',
  'js/cv-ready.js',
  'js/export.js',
  'js/ocr.js',
  'js/pipeline.js',
  'js/table.js',
  'vendor/opencv.js',
  'vendor/ort.wasm.min.js',
  'vendor/ort-wasm-simd-threaded.mjs',
  'vendor/ort-wasm-simd-threaded.wasm',
  'vendor/ppocrv5_det.onnx',
  'vendor/ppocrv5_rec.onnx',
  'vendor/ppocrv5_dict.json',
  'vendor/xlsx.full.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache: 'reload'：不用瀏覽器的 HTTP 快取，一律向網站拿最新的檔案
      // （GitHub Pages 會讓瀏覽器把檔案快取 10 分鐘，不加這個會存到舊檔）
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('table-ocr-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 本機開發（localhost）時先拿網路上的新檔案，斷線才用 cache；正式網站一律先用 cache。
const NETWORK_FIRST = self.location.hostname === 'localhost';

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (NETWORK_FIRST) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request, { ignoreSearch: true })),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)),
  );
});
