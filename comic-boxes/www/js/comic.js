// Opening and importing comic files.
//
//   .cbz .zip          read directly with JSZip
//   .cbr .rar          extracted with libarchive (WASM), saved as CBZ
//   .cb7 .7z           extracted with libarchive, saved as CBZ
//   .cbt .tar          extracted with libarchive, saved as CBZ
//   .epub              a book with text: kept as EPUB and read in the book reader (book.js)
//                      only pictures (comics, manga): pages put in reading order, saved as CBZ
//   .mobi .prc .azw    Kindle books without DRM, kept as they are (book.js)
//   .fb2 .txt          books, kept as they are (book.js)
//   .pdf               kept as PDF, pages drawn with pdf.js while reading
//   folder of images   packed into a CBZ
//
// Converting comics at import time means the comic reader only ever deals with CBZ or PDF.

import { LazyZip, writeZip } from './zip.js';
import { lazyRar } from './rar.js';
import { bookInfo, bookFormatFor, plainCover, BookError } from './book.js';

export const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp|jxl)$/i;
export const COMIC_RE = /\.(cbz|zip|cbr|rar|cb7|7z|cbt|tar|pdf|epub|mobi|prc|azw|azw3|fb2|txt)$/i;
// Plain text files are only books when picked on their own (not a readme next to comics).
export const TEXT_RE = /\.txt$/i;
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

// Phones and tablets give a web page much less memory than a computer. Formats that can only be
// opened by loading the whole file get a size limit there, so a huge file is skipped with a
// message instead of making Safari close the page.
const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
const WHOLE_FILE_LIMIT = IS_MOBILE ? 250e6 : 1500e6;
const mb = (n) => `${Math.round(n / 1e6)} MB`;
function checkWholeFile(file, what) {
  if (file.size > WHOLE_FILE_LIMIT) {
    throw new ImportError(`${file.name} (${mb(file.size)}) is too big to open on this device as ${what}. `
      + 'Convert it to CBZ on a computer (see README), then add the CBZ.');
  }
}

// Decodes one page from a tiny one-page RAR (see rar.js). One at a time, to keep memory low.
let decodeQueue = Promise.resolve();
function decodeRarPage(mini) {
  const job = decodeQueue.then(async () => {
    const Archive = await libarchive();
    const arc = await Archive.open(new File([mini], 'page.rar'));
    try {
      await arc.extractFiles();
      const files = (await arc.getFilesArray()).filter((e) => e.file && e.file.size !== undefined);
      if (!files.length) throw new Error('page missing');
      return files[0].file;
    } finally {
      arc.close();
    }
  });
  decodeQueue = job.catch(() => {});
  return job;
}

async function openRar(blob) {
  const rar = await lazyRar(blob, decodeRarPage);
  if (!rar) return null;
  const pages = rar.entries
    .filter((e) => IMAGE_RE.test(e.name) && !isJunk(e.name))
    .sort((a, b) => naturalCompare(a.name, b.name));
  return { rar, pages };
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
  // Give pdf.js the file in pieces as it asks for them, instead of loading it all into memory.
  const first = new Uint8Array(await blob.slice(0, Math.min(blob.size, 1 << 16)).arrayBuffer());
  const transport = new lib.PDFDataRangeTransport(blob.size, first);
  transport.requestDataRange = (begin, end) => {
    blob.slice(begin, end).arrayBuffer().then((buf) => transport.onDataRange(begin, new Uint8Array(buf)));
  };
  const task = lib.getDocument({
    range: transport,
    length: blob.size,
    rangeChunkSize: 1 << 18,
    disableAutoFetch: true,
    disableStream: true,
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
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
  canvas.width = canvas.height = 0; // free memory early on iOS
  return blob;
}

// ---------- opening a stored comic for reading ----------
export async function openBook(blob, format = 'cbz') {
  if (format === 'pdf') {
    const doc = await openPdf(blob);
    // Sharp enough for a few levels of zoom without using too much memory.
    const target = Math.min(IS_MOBILE ? 2400 : 3200, Math.round(Math.max(screen.height, screen.width) * (devicePixelRatio || 1) * 1.25));
    // Draw one page at a time: drawing several big pages at once can use too much memory.
    let queue = Promise.resolve();
    let drawn = 0;
    return {
      count: doc.numPages,
      preload: 1,
      page(i) {
        const job = queue.then(async () => {
          const out = await renderPdfPage(doc, i, target);
          if (++drawn % 8 === 0) await doc.cleanup().catch(() => {}); // let pdf.js free cached pictures
          return out;
        });
        queue = job.catch(() => {});
        return job;
      },
      close: () => doc.close(),
    };
  }
  if (format === 'rar') {
    const r = await openRar(blob);
    if (!r) throw new Error('rar unreadable');
    return {
      count: r.pages.length,
      page: (i) => r.rar.read(r.pages[i], mimeFor(r.pages[i].name)),
      close() {},
    };
  }
  // Read pages one at a time straight from storage (low memory).
  const lazy = await lazyImages(blob);
  if (lazy) {
    return {
      count: lazy.entries.length,
      page: (i) => lazy.zip.read(lazy.entries[i], mimeFor(lazy.entries[i].name)),
      close() {},
    };
  }
  // Fallback for unusual zip files.
  if (blob.size > WHOLE_FILE_LIMIT) throw new Error('too big for the fallback reader');
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

// Opens a zip without loading it into memory. Returns null if it needs the full JSZip reader.
async function lazyImages(blob) {
  let zip;
  try { zip = await LazyZip.open(blob); } catch { return null; }
  const entries = zip.entries
    .filter((e) => !e.dir && IMAGE_RE.test(e.name) && !isJunk(e.name))
    .sort((a, b) => naturalCompare(a.name, b.name));
  if (!zip.canRead(entries)) return null;
  return { zip, entries };
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
  const pad = Math.max(3, String(images.length).length);
  // Images are already compressed, so they're stored as-is (fast, same size, low memory).
  return writeZip(images.map((img, i) => ({
    name: `${String(i + 1).padStart(pad, '0')}.${extOf(img.name) || 'jpg'}`,
    blob: img.blob,
  })), 'application/vnd.comicbook+zip');
}

async function finish(blob, format, source, firstPage, pages) {
  const { cover, color, ratio } = await makeCover(firstPage);
  return { blob, format, source, pages, cover, color, ratio };
}

// ---------- the different formats ----------
async function fromZip(file, source) {
  const lazy = await lazyImages(file);
  if (lazy) {
    if (!lazy.entries.length) throw new ImportError(`${file.name} has no pages inside.`);
    const first = await lazy.zip.read(lazy.entries[0], mimeFor(lazy.entries[0].name));
    return finish(file, 'cbz', source, first, lazy.entries.length);
  }
  if (await LazyZip.open(file).then(() => false, () => true)) throw new Error('not a zip'); // e.g. a RAR named .cbz
  checkWholeFile(file, 'this kind of ZIP');
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(file);
  const entries = imageEntries(zip);
  if (!entries.length) throw new ImportError(`${file.name} has no pages inside.`);
  const first = new Blob([await entries[0].async('blob')], { type: mimeFor(entries[0].name) });
  return finish(file, 'cbz', source, first, entries.length);
}

async function fromLibarchive(file) {
  if (/\.(cbr|rar|cbz|zip)$/i.test(file.name)) {
    // Most CBRs: keep the original file and read pages one at a time (no conversion, low memory).
    const r = await openRar(file);
    if (r) {
      if (!r.pages.length) throw new ImportError(`${file.name} has no pages inside.`);
      const first = await r.rar.read(r.pages[0], mimeFor(r.pages[0].name));
      return finish(file, 'rar', extOf(file.name) === 'rar' ? 'RAR' : 'CBR', first, r.pages.length);
    }
    // A "CBR" that is really a ZIP file.
    const z = await lazyImages(file);
    if (z) {
      if (!z.entries.length) throw new ImportError(`${file.name} has no pages inside.`);
      return finish(file, 'cbz', 'CBR', await z.zip.read(z.entries[0], mimeFor(z.entries[0].name)), z.entries.length);
    }
  }
  // Solid RARs, 7z and tar: these have to be unpacked whole.
  checkWholeFile(file, extOf(file.name).toUpperCase());
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
    // Close the archive first: this frees the memory it used before the new file is built.
    arc.close();
    arc = null;
    const cbz = await packCbz(images);
    return finish(cbz, 'cbz', extOf(file.name).toUpperCase(), images[0].blob, images.length);
  } finally {
    arc?.close();
  }
}

// Books keep their original file. The cover is the book's own picture, or a plain one with its title.
async function fromBook(file, format, source) {
  let info;
  try {
    info = await bookInfo(file, format);
  } catch (e) {
    if (e instanceof BookError) throw new ImportError(`${file.name}: ${e.message}`);
    throw e;
  }
  if (!info) return null;
  const title = info.title || prettyName(file.name);
  let look = null;
  if (info.cover) { try { look = await makeCover(info.cover); } catch { look = null; } }
  if (!look) look = await plainCover(title, info.author);
  return { blob: file, format, source, pages: info.chapters, cover: look.cover, color: look.color, ratio: look.ratio,
    title: info.title, author: info.author };
}

async function fromEpub(file) {
  // A book with text is read as a book; an EPUB of pictures (comics, manga) becomes a comic.
  // If it can't be read as a book, it's still tried as pictures.
  let bookError = null;
  const asBook = await fromBook(file, 'epub', 'EPUB').catch((e) => {
    console.warn(e);
    if (e instanceof ImportError) bookError = e;
    return null;
  });
  if (asBook) return asBook;
  try {
    return await epubAsComic(file);
  } catch (e) {
    throw bookError || e;
  }
}

async function epubAsComic(file) {
  checkWholeFile(file, 'EPUB');
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(file);
  const ordered = await epubPageOrder(zip);
  const entries = ordered.length ? ordered : imageEntries(zip);
  if (!entries.length) throw new ImportError(`${file.name} has nothing to read inside. It may be damaged.`);
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
  const bookFormat = bookFormatFor(ext);
  if (bookFormat) {
    const source = ext === 'prc' || ext === 'azw' ? 'MOBI' : ext.toUpperCase();
    const r = await fromBook(file, bookFormat, source);
    if (!r) throw new ImportError(`${file.name} has nothing to read inside.`);
    return r;
  }
  if (ext === 'pdf') return fromPdf(file);
  throw new ImportError(`${file.name} isn't a comic or book file.`);
}

// A .zip that holds comic files (or folders of comics) is treated like a folder.
// Returns entries for the folder importer, or null if this zip is a single comic.
export async function expandFolderZip(file, basePath) {
  if (!/\.zip$/i.test(file.name)) return null;
  let zip;
  try { zip = await LazyZip.open(file); } catch { return null; }
  const files = zip.entries.filter((f) => !f.dir && !isJunk(f.name));
  if (!files.some((f) => COMIC_RE.test(f.name))) return null;
  if (!zip.canRead(files)) return null;

  // Use the zip's own top folder if everything is inside one, otherwise the zip's name.
  const tops = new Set(files.map((f) => (f.name.includes('/') ? f.name.split('/')[0] : '')));
  const wrapped = tops.size === 1 && !tops.has('');
  const prefix = basePath + (wrapped ? '' : prettyName(file.name) + '/');
  return files.map((f) => {
    const name = f.name.split('/').pop();
    return {
      path: prefix + f.name,
      name,
      size: f.size,
      // Only this one comic is read out of the zip, when it's its turn.
      load: async () => new File([await zip.read(f)], name),
    };
  });
}
