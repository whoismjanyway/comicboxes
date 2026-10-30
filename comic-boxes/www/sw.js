// Makes the app open and work without internet, and controls when it uses the internet at all.
//
// Your comics never use the internet: they're stored on the device (IndexedDB). The only thing
// this file ever downloads is the app's own files (about 4 MB), and only:
//   - "Only when I tap" (default): never by itself. Updates happen when you tap
//     Settings > Check for updates, so you can do it on Wi-Fi.
//   - "Automatic": checks for updates when the app opens. On Android it waits for Wi-Fi;
//     iPhones don't tell web apps whether they're on Wi-Fi or mobile data.
//
// Bump VERSION whenever you change any file in www/ so devices can pick up the update.
const VERSION = 'comic-boxes-v11';
const META = 'comic-boxes-meta'; // settings shared with the page: { updates, approvedUntil }

const APP_FILES = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/comic.js', 'js/importer.js', 'js/reader.js', 'js/settings.js', 'js/zip.js', 'js/rar.js',
  'js/qr.js', 'js/transfer.js', 'js/share.js', 'js/relay.js', 'js/backup.js',
];
const STATIC_FILES = [
  'fonts/BarlowCondensed-SemiBold.woff', 'fonts/BarlowCondensed-ExtraBold.woff', 'fonts/PermanentMarker.woff',
  'vendor/jszip.min.js', 'vendor/qr/qrcode.js', 'vendor/qr/jsQR.js',
  'vendor/libarchive/libarchive.js', 'vendor/libarchive/worker-bundle.js', 'vendor/libarchive/libarchive.wasm',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js',
  'vendor/pdfjs/wasm/openjpeg.wasm', 'vendor/pdfjs/wasm/jbig2.wasm', 'vendor/pdfjs/wasm/qcms_bg.wasm',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];
const ALL_FILES = [...APP_FILES, ...STATIC_FILES];
const NETWORK_TIMEOUT = 2500;
const IS_VERSION_CACHE = /^comic-boxes-v\d+$/;

const abs = (path) => new URL(path, self.registration.scope).href;
const STATIC_SET = new Set(STATIC_FILES.map(abs));
const INDEX = () => abs('./');
let usingSavedCopyUntil = 0;

// ---------- settings shared with the page ----------
async function readMeta() {
  try {
    const hit = await (await caches.open(META)).match('meta.json');
    return hit ? await hit.json() : {};
  } catch { return {}; }
}
// On Android Chrome the browser says whether the connection is mobile data (or Data Saver is on).
function onMobileData() {
  const c = self.navigator && self.navigator.connection;
  return !!(c && (c.type === 'cellular' || c.saveData));
}
// May the app go online by itself right now?
async function mayUseNetwork() {
  const meta = await readMeta();
  if (meta.approvedUntil > Date.now()) return true;      // the user just tapped "Check for updates"
  if (meta.updates === 'auto') return !onMobileData();
  return meta.updates === undefined;                     // not set yet: behave like before
}

// ---------- saving the app for offline use ----------
async function saveAll(cache) {
  const results = await Promise.allSettled(ALL_FILES.map(async (path) => {
    const res = await fetch(abs(path), { cache: 'reload' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    await cache.put(abs(path), res.redirected ? new Response(await res.blob(), { headers: res.headers }) : res);
  }));
  return results.filter((r) => r.status === 'rejected').length;
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    const hasOlderCopy = keys.some((k) => IS_VERSION_CACHE.test(k) && k !== VERSION);
    // A new version was found. Unless updates are allowed right now, don't download it:
    // keep using the copy already on the phone. (The very first install always proceeds.)
    if (hasOlderCopy && !(await mayUseNetwork())) throw new Error('Update postponed until allowed');
    const cache = await caches.open(VERSION);
    await saveAll(cache);
    for (const path of APP_FILES) {
      if (!(await cache.match(abs(path)))) throw new Error(`Missing ${path}`);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => IS_VERSION_CACHE.test(k) && k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ---------- answering requests ----------
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
    const key = req.mode === 'navigate' ? INDEX() : url.origin + url.pathname;
    const saved = (await cache.match(key)) || (req.mode === 'navigate' ? await cache.match(abs('index.html')) : null);

    // Offline-first: when the app may not go online by itself, use only the saved copy.
    // (The network is used only if a file was somehow never saved.)
    if (saved && (STATIC_SET.has(key) || !(await mayUseNetwork()))) return saved;

    // Automatic updates: try the network briefly, then fall back to the saved copy.
    if (saved && Date.now() < usingSavedCopyUntil) return saved;
    const network = fromNetwork(req, cache, key);
    try {
      const res = await withTimeout(network, NETWORK_TIMEOUT);
      if (res.ok) return res;
    } catch { /* offline or too slow */ }
    network.catch(() => {});
    if (req.mode === 'navigate') usingSavedCopyUntil = Date.now() + 30000;
    if (saved) return saved;
    try { return await network; } catch { return new Response('', { status: 504, statusText: 'Offline' }); }
  })());
});

// ---------- questions from the Settings page ----------
self.addEventListener('message', (e) => {
  if (e.data !== 'offline-status') return;
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    const missing = [];
    for (const path of ALL_FILES) if (!(await cache.match(abs(path)))) missing.push(path);
    // Fill gaps only when going online is allowed right now.
    if (missing.length && (await mayUseNetwork())) await saveAll(cache);
    const still = [];
    for (const path of missing) if (!(await cache.match(abs(path)))) still.push(path);
    e.source && e.source.postMessage({ type: 'offline-status', version: VERSION, missing: still });
  })());
});
