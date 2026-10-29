// Opening and importing comic files.
//
//   .cbz .zip          read directly with JSZip
//   .cbr .rar          extracted with libarchive (WASM), saved as CBZ
//   .cb7 .7z           extracted with libarchive, saved as CBZ
//   .cbt .tar          extracted with libarchive, saved as CBZ
//   .epub              pages put in reading order, saved as CBZ
//   .pdf               kept as PDF, pages drawn with pdf.js while reading
//   folder of images   packed into a CBZ
//
// Converting at import time means the reader only ever deals with CBZ or PDF.

export const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i;
export const COMIC_RE = /\.(cbz|zip|cbr|rar|cb7|7z|cbt|tar|pdf|epub)$/i;
const LIBARCHIVE_RE = /\.(cbr|rar|cb7|7z|cbt|tar)$/i;
const JUNK_RE = /(^|\/)(__MACOSX|\.[^/]*|Thumbs\.db)(\/|$)/i;

export const isJunk = (path) => JUNK_RE.test(path);
export const extOf = (name) => (name.match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();

export function prettyName(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', jxl: 'image/jxl' };
const mimeFor = (name) => MIME[extOf(name)] || 'image/jpeg';

// ---------- lazily loaded libraries ----------
let libarchivePromise;
function libarchive() {
  libarchivePromise ??= import('../vendor/libarchive/libarchive.js').then((m) => {
    m.Archive.init({ workerUrl: new URL('../vendor/libarchive/worker-bundle.js', import.meta.url).href });
    return m.Archive;
  });
  return libarchivePromise;
}

let pdfjsPromise;
function pdfjs() {
  pdfjsPromise ??= import('../vendor/pdfjs/pdf.min.js').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}
async function openPdf(blob) {
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    wasmUrl: new URL('../vendor/pdfjs/wasm/', import.meta.url).href,
    isEvalSupported: false,
    enableScripting: false,
  });
  const doc = await task.promise;
  // pdf.js frees a document through its loading task.
  doc.close = () => task.destroy();
  return doc;
}
async function renderPdfPage(doc, n, targetHeight) {
  const page = await doc.getPage(n + 1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(0.5, targetHeight / base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
  page.cleanup();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.9));
  canvas.width = canvas.height = 0; // free memory early on iOS
  return blob;
}

// ---------- opening a stored comic for reading ----------
export async function openBook(blob, format = 'cbz') {
  if (format === 'pdf') {
    const doc = await openPdf(blob);
    // Sharp enough for a few levels of zoom without using too much memory.
    const target = Math.min(3200, Math.round(Math.max(screen.height, screen.width) * (devicePixelRatio || 1) * 1.25));
    return {
      count: doc.numPages,
      page: (i) => renderPdfPage(doc, i, target),
      close: () => doc.close(),
    };
  }
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(blob);
  const entries = imageEntries(zip);
  return {
    count: entries.length,
    async page(i) {
      const raw = await entries[i].async('blob');
      return new Blob([raw], { type: mimeFor(entries[i].name) });
    },
    close() {},
  };
}

function imageEntries(zip) {
  return Object.values(zip.files)
    .filter((f) => !f.dir && IMAGE_RE.test(f.name) && !isJunk(f.name))
    .sort((a, b) => naturalCompare(a.name, b.name));
}

// ---------- covers ----------
async function loadImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function makeCover(blob) {
  const img = await loadImage(blob);
  const w = 400;
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 600;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  // Average color of the masthead area: used for the bag tint and placeholder.
  const d = ctx.getImageData(Math.round(w * 0.1), Math.round(h * 0.03), Math.round(w * 0.8), Math.round(h * 0.12)).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 32) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  const color = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
  const cover = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
  return { cover, color, ratio: h / w };
}

// ---------- packing images into a CBZ ----------
async function packCbz(images) {
  // eslint-disable-next-line no-undef
  const zip = new JSZip();
  const pad = String(images.length).length;
  images.forEach((img, i) => {
    zip.file(`${String(i + 1).padStart(Math.max(3, pad), '0')}.${extOf(img.name) || 'jpg'}`, img.blob);
  });
  // Images are already compressed, so "STORE" is fast and just as small.
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/vnd.comicbook+zip' });
}

async function finish(blob, format, source, firstPage, pages) {
  const { cover, color, ratio } = await makeCover(firstPage);
  return { blob, format, source, pages, cover, color, ratio };
}

// ---------- the different formats ----------
async function fromZip(file, source) {
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(file);
  const entries = imageEntries(zip);
  if (!entries.length) throw new ImportError(`${file.name} has no pages inside.`);
  const first = new Blob([await entries[0].async('blob')], { type: mimeFor(entries[0].name) });
  return finish(file, 'cbz', source, first, entries.length);
}

async function fromLibarchive(file) {
  const Archive = await libarchive();
  let arc;
  try {
    arc = await Archive.open(file);
  } catch {
    throw new ImportError(`${file.name} couldn't be opened. It may be damaged.`);
  }
  try {
    if (await arc.hasEncryptedData()) throw new ImportError(`${file.name} is password protected.`);
    await arc.extractFiles();
    const all = await arc.getFilesArray();
    const images = all
      .map((e) => ({ name: (e.path || '') + e.file.name, blob: e.file }))
      .filter((e) => IMAGE_RE.test(e.name) && !isJunk(e.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (!images.length) throw new ImportError(`${file.name} has no pages inside.`);
    images.forEach((im) => { im.blob = new Blob([im.blob], { type: mimeFor(im.name) }); });
    const cbz = await packCbz(images);
    return finish(cbz, 'cbz', extOf(file.name).toUpperCase(), images[0].blob, images.length);
  } finally {
    arc.close();
  }
}

async function fromEpub(file) {
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(file);
  const ordered = await epubPageOrder(zip);
  const entries = ordered.length ? ordered : imageEntries(zip);
  if (!entries.length) throw new ImportError(`${file.name} has no pictures inside.`);
  const images = [];
  for (const e of entries) images.push({ name: e.name, blob: new Blob([await e.async('blob')], { type: mimeFor(e.name) }) });
  const cbz = await packCbz(images);
  return finish(cbz, 'cbz', 'EPUB', images[0].blob, images.length);
}

// Follows the book's reading order (OPF spine) and takes the first picture on each page.
async function epubPageOrder(zip) {
  try {
    const parser = new DOMParser();
    const resolve = (base, href) => {
      const parts = (base.replace(/[^/]*$/, '') + decodeURIComponent(href.split('#')[0])).split('/');
      const out = [];
      for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
      return out.join('/');
    };
    const container = await zip.file('META-INF/container.xml')?.async('string');
    const opfPath = container && parser.parseFromString(container, 'application/xml').querySelector('rootfile')?.getAttribute('full-path');
    if (!opfPath) return [];
    const opf = parser.parseFromString(await zip.file(opfPath).async('string'), 'application/xml');
    const manifest = new Map([...opf.getElementsByTagName('item')].map((i) => [i.getAttribute('id'), i]));
    const seen = new Set();
    const out = [];
    for (const ref of opf.getElementsByTagName('itemref')) {
      const item = manifest.get(ref.getAttribute('idref'));
      if (!item) continue;
      const href = resolve(opfPath, item.getAttribute('href'));
      let imgPath = null;
      if (IMAGE_RE.test(href)) imgPath = href;
      else {
        const html = await zip.file(href)?.async('string');
        if (!html) continue;
        const m = html.match(/<(?:img|image)\b[^>]*?(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/i);
        if (m) imgPath = resolve(href, m[1]);
      }
      const entry = imgPath && zip.file(imgPath);
      if (entry && !seen.has(imgPath)) { seen.add(imgPath); out.push(entry); }
    }
    return out;
  } catch {
    return [];
  }
}

async function fromPdf(file) {
  let doc;
  try {
    doc = await openPdf(file);
  } catch (e) {
    throw new ImportError(e && e.name === 'PasswordException'
      ? `${file.name} is password protected.`
      : `${file.name} couldn't be opened. It may be damaged.`);
  }
  try {
    const first = await renderPdfPage(doc, 0, 900);
    return finish(file, 'pdf', 'PDF', first, doc.numPages);
  } finally {
    doc.close();
  }
}

export async function fromImages(name, files) {
  const images = files
    .map((f) => ({ name: f.path || f.name, file: f }))
    .sort((a, b) => naturalCompare(a.name, b.name));
  const loaded = [];
  for (const im of images) {
    const blob = await im.file.load();
    loaded.push({ name: im.name, blob: new Blob([blob], { type: mimeFor(im.name) }) });
  }
  const cbz = await packCbz(loaded);
  return finish(cbz, 'cbz', 'Images', loaded[0].blob, loaded.length);
}

export class ImportError extends Error {}

export async function importComic(file) {
  const ext = extOf(file.name);
  if (ext === 'cbz' || ext === 'zip') {
    try {
      return await fromZip(file, ext.toUpperCase());
    } catch (e) {
      // Some .cbz files are really RAR or 7z archives with the wrong name.
      if (e instanceof ImportError) throw e;
      return fromLibarchive(file);
    }
  }
  if (ext === 'cbr') {
    // ...and many .cbr files are really zip files. libarchive reads both.
    return fromLibarchive(file);
  }
  if (LIBARCHIVE_RE.test(file.name)) return fromLibarchive(file);
  if (ext === 'epub') return fromEpub(file);
  if (ext === 'pdf') return fromPdf(file);
  throw new ImportError(`${file.name} isn't a comic file.`);
}

// A .zip that holds comic files (or folders of comics) is treated like a folder.
// Returns entries for the folder importer, or null if this zip is a single comic.
export async function expandFolderZip(file, basePath) {
  if (!/\.zip$/i.test(file.name)) return null;
  let zip;
  // eslint-disable-next-line no-undef
  try { zip = await JSZip.loadAsync(file); } catch { return null; }
  const files = Object.values(zip.files).filter((f) => !f.dir && !isJunk(f.name));
  if (!files.some((f) => COMIC_RE.test(f.name))) return null;

  // Use the zip's own top folder if everything is inside one, otherwise the zip's name.
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  const wrapped = tops.size === 1 && !tops.has('');
  const prefix = basePath + (wrapped ? '' : prettyName(file.name) + '/');
  return files.map((f) => ({
    path: prefix + f.name,
    name: f.name.split('/').pop(),
    size: f._data ? f._data.uncompressedSize : 0,
    load: async () => new File([await f.async('blob')], f.name.split('/').pop()),
  }));
}
