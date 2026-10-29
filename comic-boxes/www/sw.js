// Makes the app open and work without internet.
// Your comics are stored separately (IndexedDB); this only keeps the app's own files.
//
// Bump VERSION whenever you change any file in www/ so devices pick up the update.
const VERSION = 'comic-boxes-v6';

// The app itself. Checked online first (with a short time limit) so updates arrive quickly.
const APP_FILES = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/comic.js', 'js/importer.js', 'js/reader.js', 'js/settings.js', 'js/zip.js', 'js/rar.js',
];
// Big files that rarely change. Served straight from the cache.
const STATIC_FILES = [
  'fonts/BarlowCondensed-SemiBold.woff', 'fonts/BarlowCondensed-ExtraBold.woff', 'fonts/PermanentMarker.woff',
  'vendor/jszip.min.js',
  'vendor/libarchive/libarchive.js', 'vendor/libarchive/worker-bundle.js', 'vendor/libarchive/libarchive.wasm',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/wasm/jbig2.wasm', 'vendor/pdfjs/wasm/qcms_bg.wasm',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
const ALL_FILES = [...APP_FILES, ...STATIC_FILES];
const NETWORK_TIMEOUT = 2500; // ms. On a weak connection, fall back to the saved copy quickly.

const abs = (path) => new URL(path, self.registration.scope).href;
const STATIC_SET = new Set(STATIC_FILES.map(abs));
const INDEX = () => abs('./');
// When opening the app had to fall back to the saved copy, load the rest of that launch
// from the saved copy too, instead of waiting on the network again for every file.
let usingSavedCopyUntil = 0;

// Save each file on its own, so one failed download doesn't throw away the whole offline copy.
async function saveAll(cache) {
  const results = await Promise.allSettled(ALL_FILES.map(async (path) => {
    const res = await fetch(abs(path), { cache: 'reload' }); // skip the browser's HTTP cache
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    // Safari refuses to show a page from a "redirected" response, so store a clean copy.
    await cache.put(abs(path), res.redirected ? new Response(await res.blob(), { headers: res.headers }) : res);
  }));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) console.warn('Offline copy incomplete:', failed.map((f) => f.reason && f.reason.message));
  return failed.length;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await saveAll(cache);
    // The page and its scripts are required; without them, keep using the previous version.
    for (const path of APP_FILES) {
      if (!(await cache.match(abs(path)))) throw new Error(`Missing ${path}`);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('comic-boxes-') && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

async function fromNetwork(request, cache, saveAs) {
  const res = await fetch(request);
  if (res.ok && !res.redirected) cache.put(saveAs || request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);

    // Opening the app (from the home screen icon, a bookmark, or a link inside the app).
    if (req.mode === 'navigate') {
      const network = fromNetwork(req, cache, INDEX());
      try {
        const res = await withTimeout(network, NETWORK_TIMEOUT);
        if (res.ok) return res;
      } catch { /* offline or too slow */ }
      network.catch(() => {}); // let a slow download finish in the background
      usingSavedCopyUntil = Date.now() + 30000;
      // The app is one page, so every address inside it opens the saved index.
      return (await cache.match(INDEX())) || (await cache.match(abs('index.html'))) || network;
    }

    const key = url.origin + url.pathname; // ignore ?query strings

    // Fonts, libraries, icons: cache first.
    if (STATIC_SET.has(key)) {
      const hit = await cache.match(key);
      if (hit) return hit;
      return fromNetwork(req, cache, key);
    }

    // App scripts and styles: network first with a time limit, then the saved copy.
    if (Date.now() < usingSavedCopyUntil) {
      const hit = await cache.match(key);
      if (hit) { fromNetwork(req, cache, key).catch(() => {}); return hit; }
    }
    const network = fromNetwork(req, cache, key);
    try {
      const res = await withTimeout(network, NETWORK_TIMEOUT);
      if (res.ok) return res;
    } catch { /* offline or too slow */ }
    network.catch(() => {});
    const hit = await cache.match(key);
    if (hit) return hit;
    try { return await network; } catch { return new Response('', { status: 504, statusText: 'Offline' }); }
  })());
});

// Lets the Settings page ask whether everything is saved for offline use.
self.addEventListener('message', (e) => {
  if (e.data !== 'offline-status') return;
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const missing = [];
    for (const path of ALL_FILES) if (!(await cache.match(abs(path)))) missing.push(path);
    if (missing.length) await saveAll(cache); // try to fill gaps while we're here
    const still = [];
    for (const path of missing) if (!(await cache.match(abs(path)))) still.push(path);
    e.source && e.source.postMessage({ type: 'offline-status', version: VERSION, missing: still });
  })());
});
