// Offline cache for the app itself (your comics are stored separately in IndexedDB).
// Bump VERSION whenever you change any file in www/ so phones pick up the update.
const VERSION = 'comic-boxes-v3';
const FILES = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/comic.js', 'js/importer.js', 'js/reader.js', 'js/settings.js',
  'fonts/BarlowCondensed-SemiBold.woff', 'fonts/BarlowCondensed-ExtraBold.woff', 'fonts/PermanentMarker.woff',
  'vendor/jszip.min.js',
  'vendor/libarchive/libarchive.js', 'vendor/libarchive/worker-bundle.js', 'vendor/libarchive/libarchive.wasm',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/wasm/jbig2.wasm', 'vendor/pdfjs/wasm/qcms_bg.wasm',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so updates show up right away; the cache is used when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
