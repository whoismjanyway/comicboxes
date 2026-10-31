// Books made of text: EPUB, MOBI (also .prc and .azw), FB2 and TXT.
//
// Comics are turned into pages of pictures when they're added. Books are different: the original
// file is kept, and the text is laid out by the browser while you read, so you can choose the
// font, text size, spacing, margins and colours (see bookreader.js).
// An EPUB that is only pictures (most comic and manga EPUBs) is still added as a comic.
//
// Every format is opened into the same shape:
//   {
//     format, title, author, lang, rtl,
//     chapters: [{ href, size }],          // in reading order; href is the chapter's path
//     toc: [{ title, href, depth }],       // table of contents; href may end in #id
//     ids: Map(id → chapter index),        // only for formats whose notes point across chapters
//     load(i)  → { text, type }            // the chapter's (X)HTML
//     blob(path), text(path), url(path)    // pictures, stylesheets and fonts inside the book
//     coverPath, close()
//   }

import { LazyZip } from './zip.js';

export const BOOK_FORMATS = ['epub', 'mobi', 'fb2', 'txt'];
export const isBookFormat = (f) => BOOK_FORMATS.includes(f);
export class BookError extends Error {}

const IS_MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.userAgent));
const WHOLE_FILE_LIMIT = IS_MOBILE ? 250e6 : 1500e6;
function checkSize(blob, what) {
  if (blob.size > WHOLE_FILE_LIMIT) throw new BookError(`This ${what} (${Math.round(blob.size / 1e6)} MB) is too big to open on this device.`);
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', svg: 'image/svg+xml', css: 'text/css', xhtml: 'application/xhtml+xml', html: 'text/html',
  htm: 'text/html', xml: 'application/xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4',
};
const extOf = (p) => (p.match(/\.([^./]+)$/) || [, ''])[1].toLowerCase();
const mimeOf = (p) => MIME[extOf(p)] || '';

// ---------- small helpers ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const byLocal = (root, name) => [...root.getElementsByTagNameNS('*', name)];
const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href);

function parseXml(text) {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  return d.getElementsByTagName('parsererror').length ? null : d;
}

// "OEBPS/Text/ch1.xhtml" + "../Images/a.jpg#x" → "OEBPS/Images/a.jpg"
export function resolvePath(base, href) {
  let h = href.split('#')[0].split('?')[0];
  try { h = decodeURIComponent(h); } catch { /* keep as is */ }
  if (!h) return base;
  const parts = (h.startsWith('/') ? h.slice(1) : base.replace(/[^/]*$/, '') + h).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
export const fragOf = (href) => { const i = href.indexOf('#'); return i < 0 ? '' : href.slice(i + 1); };

// Text files say which characters they use in different ways. Try the usual ones in order.
function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 300));
  const declared = (head.match(/^<\?xml[^>]*encoding\s*=\s*["']([\w.-]+)["']/i) || [])[1];
  if (declared && !/^utf-?8$/i.test(declared)) {
    try { return new TextDecoder(declared).decode(bytes); } catch { /* unknown name: fall through */ }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  return new TextDecoder('windows-1252').decode(bytes);
}

// Remembers a picture or font's blob: URL so it is made only once, and frees them all on close.
function urlCache(getBlob) {
  const urls = new Map();
  return {
    url(path) {
      if (!urls.has(path)) urls.set(path, getBlob(path).then((b) => (b ? URL.createObjectURL(b) : '')).catch(() => ''));
      return urls.get(path);
    },
    close() {
      for (const u of urls.values()) u.then((x) => x && URL.revokeObjectURL(x));
      urls.clear();
    },
  };
}

// ---------- ZIP access (EPUB) ----------
async function openZip(blob) {
  let lazy = null;
  try { lazy = await LazyZip.open(blob); } catch { lazy = null; }
  if (lazy) {
    const files = lazy.entries.filter((e) => !e.dir);
    if (lazy.canRead(files)) return zipApi(new Map(files.map((e) => [e.name, e])), (e, type) => lazy.read(e, type), (e) => e.size);
  }
  checkSize(blob, 'book');
  // eslint-disable-next-line no-undef
  const zip = await JSZip.loadAsync(blob);
  const files = Object.values(zip.files).filter((f) => !f.dir);
  return zipApi(new Map(files.map((f) => [f.name, f])),
    async (f, type) => new Blob([await f.async('arraybuffer')], { type }),
    (f) => (f._data && f._data.uncompressedSize) || 0);
}
function zipApi(map, read, sizeOf) {
  const lower = new Map([...map.keys()].map((k) => [k.toLowerCase(), k]));
  // Some books get the capitals of their own file names wrong.
  const find = (p) => map.get(p) || map.get(lower.get(String(p).toLowerCase()));
  const api = {
    names: [...map.keys()],
    has: (p) => !!find(p),
    size: (p) => { const e = find(p); return e ? sizeOf(e) : 0; },
    blob: async (p) => { const e = find(p); return e ? read(e, mimeOf(p)) : null; },
    text: async (p) => { const b = await api.blob(p); return b ? decodeText(new Uint8Array(await b.arrayBuffer())) : null; },
  };
  return api;
}

// ---------- EPUB ----------
async function openEpub(blob) {
  const zip = await openZip(blob);
  let opfPath = null;
  const container = parseXml((await zip.text('META-INF/container.xml')) || '');
  if (container) opfPath = byLocal(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !zip.has(opfPath)) opfPath = zip.names.find((n) => /\.opf$/i.test(n));
  if (!opfPath) throw new BookError('This EPUB is damaged: its list of contents is missing.');
  const opf = parseXml(await zip.text(opfPath));
  if (!opf) throw new BookError('This EPUB is damaged: its list of contents can\'t be read.');
  // Copy-protected (DRM) books have their pages scrambled. Only fonts may be scrambled in a normal book.
  const encryption = parseXml((await zip.text('META-INF/encryption.xml')) || '');
  if (zip.has('META-INF/rights.xml') || (encryption && byLocal(encryption, 'EncryptionMethod').some((m) => {
    const alg = m.getAttribute('Algorithm') || '';
    return !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(alg);
  }))) throw new BookError('This EPUB is copy-protected (DRM), so it can\'t be opened here.');

  const meta = (name) => byLocal(opf, name)[0]?.textContent.replace(/\s+/g, ' ').trim() || '';
  const items = new Map();
  for (const it of byLocal(opf, 'item')) {
    items.set(it.getAttribute('id'), {
      id: it.getAttribute('id'),
      href: resolvePath(opfPath, it.getAttribute('href') || ''),
      type: it.getAttribute('media-type') || '',
      props: (it.getAttribute('properties') || '').split(/\s+/),
    });
  }
  const spineEl = byLocal(opf, 'spine')[0];
  const refs = byLocal(opf, 'itemref')
    .map((r) => ({ item: items.get(r.getAttribute('idref')), linear: r.getAttribute('linear') !== 'no' }))
    .filter((r) => r.item);
  let spine = refs.filter((r) => r.linear);
  if (!spine.length) spine = refs;
  const chapters = spine.map(({ item }) => ({ href: item.href, type: item.type, size: zip.size(item.href) || 1 }));

  const metas = byLocal(opf, 'meta');
  const fixed = metas.some((m) => m.getAttribute('property') === 'rendition:layout' && m.textContent.trim() === 'pre-paginated');

  // Cover picture: EPUB 3 marks it, EPUB 2 names it in a <meta>, others just call it "cover".
  const all = [...items.values()];
  const isImg = (i) => i && /^image\//.test(i.type);
  let cover = all.find((i) => i.props.includes('cover-image'));
  if (!isImg(cover)) cover = items.get(metas.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content'));
  if (!isImg(cover)) cover = all.find((i) => isImg(i) && /cover/i.test(i.id + ' ' + i.href));

  // Table of contents: the EPUB 3 "nav" page, or the older toc.ncx.
  let toc = [];
  try {
    const nav = all.find((i) => i.props.includes('nav'));
    if (nav) toc = parseNav(await zip.text(nav.href), nav.href);
    if (!toc.length) {
      const ncx = items.get(spineEl?.getAttribute('toc')) || all.find((i) => i.type === 'application/x-dtbncx+xml');
      if (ncx) toc = parseNcx(await zip.text(ncx.href), ncx.href);
    }
  } catch { toc = []; }

  const cache = urlCache((p) => zip.blob(p));
  return {
    format: 'epub',
    title: meta('title'),
    author: byLocal(opf, 'creator').map((c) => c.textContent.trim()).filter(Boolean).slice(0, 2).join(' & '),
    lang: meta('language'),
    rtl: spineEl?.getAttribute('page-progression-direction') === 'rtl',
    fixed,
    chapters,
    toc,
    coverPath: cover?.href || null,
    async load(i) {
      const ch = chapters[i];
      if (/^image\//.test(ch.type)) return { text: `<html><body><img src="${esc(ch.href.split('/').pop())}" alt=""></body></html>`, type: 'html' };
      const text = (await zip.text(ch.href)) || '';
      if (ch.type === 'image/svg+xml') return { text: `<html><body>${text.replace(/^<\?xml[^>]*>/, '')}</body></html>`, type: 'html' };
      return { text, type: /html/.test(ch.type) && !/xhtml|xml/.test(ch.type) ? 'html' : 'xhtml' };
    },
    blob: (p) => zip.blob(p),
    text: (p) => zip.text(p),
    url: cache.url,
    close: cache.close,
  };
}

function parseNav(text, base) {
  const doc = new DOMParser().parseFromString(text || '', 'text/html');
  const navs = [...doc.querySelectorAll('nav')];
  const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') || n.getAttribute('role') || '')) || navs[0];
  const out = [];
  const walk = (ol, depth) => {
    for (const li of ol.children) {
      if (li.localName !== 'li') continue;
      const a = li.querySelector(':scope > a, :scope > span');
      const title = a?.textContent.replace(/\s+/g, ' ').trim();
      const href = a?.getAttribute('href');
      if (title && href) out.push({ title, href: resolvePath(base, href) + (fragOf(href) ? `#${fragOf(href)}` : ''), depth });
      const sub = li.querySelector(':scope > ol, :scope > ul');
      if (sub) walk(sub, depth + 1);
    }
  };
  const top = nav?.querySelector('ol, ul');
  if (top) walk(top, 0);
  return out;
}

function parseNcx(text, base) {
  const doc = parseXml(text || '');
  if (!doc) return [];
  const out = [];
  const walk = (parent, depth) => {
    for (const np of parent.children) {
      if (np.localName !== 'navPoint') continue;
      const title = byLocal(np, 'text')[0]?.textContent.replace(/\s+/g, ' ').trim();
      const src = byLocal(np, 'content')[0]?.getAttribute('src');
      if (title && src) out.push({ title, href: resolvePath(base, src) + (fragOf(src) ? `#${fragOf(src)}` : ''), depth });
      walk(np, depth + 1);
    }
  };
  const map = byLocal(doc, 'navMap')[0];
  if (map) walk(map, 0);
  return out;
}

// Comic and manga EPUBs are pages of pictures with hardly any text. Those stay comics.
async function epubHasText(book) {
  if (book.fixed) return false;
  let chars = 0;
  let images = 0;
  for (let i = 0; i < Math.min(book.chapters.length, 15); i++) {
    const { text } = await book.load(i);
    images += (text.match(/<(img|image)\b/gi) || []).length;
    chars += text
      .replace(/<head[\s\S]*?<\/head>/i, ' ')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[#\w]+;/g, 'x')
      .replace(/\s+/g, ' ').trim().length;
    if (chars > 4000 && chars > images * 150) return true;
  }
  return chars >= 600 && chars > images * 150;
}

// ---------- MOBI (Kindle books without DRM: .mobi, .prc, .azw) ----------
function palmDoc(src) {
  const out = new Uint8Array(src.length * 8 + 16);
  let o = 0;
  for (let i = 0; i < src.length;) {
    const c = src[i++];
    if (c >= 1 && c <= 8) { for (let k = 0; k < c && i < src.length; k++) out[o++] = src[i++]; }
    else if (c < 0x80) out[o++] = c;
    else if (c >= 0xc0) { out[o++] = 0x20; out[o++] = c ^ 0x80; }
    else {
      const v = (c << 8) | src[i++];
      const dist = (v >> 3) & 0x7ff;
      const len = (v & 7) + 3;
      for (let k = 0; k < len; k++) { out[o] = out[o - dist]; o++; }
    }
  }
  return out.subarray(0, o);
}
// Each text record may end with extra bytes that aren't part of the text.
function trailingSize(data, flags) {
  let num = 0;
  for (let f = flags >> 1; f; f >>= 1) {
    if (!(f & 1)) continue;
    let size = data.length - num;
    let v = 0;
    let shift = 0;
    while (size > 0) {
      const b = data[--size];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) || shift >= 28) break;
    }
    num += v;
  }
  if (flags & 1) num += (data[data.length - num - 1] & 3) + 1;
  return num;
}
function imageType(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return '';
}

async function openMobi(blob) {
  checkSize(blob, 'book');
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  const ascii = (a, b) => new TextDecoder('latin1').decode(buf.subarray(a, b));
  if (buf.length < 86 || !/^(BOOKMOBI|TEXtREAd)$/.test(ascii(60, 68))) throw new BookError('This file isn\'t a Kindle book it can read.');
  const count = dv.getUint16(76);
  const offs = [];
  for (let i = 0; i < count; i++) offs.push(dv.getUint32(78 + i * 8));
  const rec = (i) => buf.subarray(offs[i], i + 1 < count ? offs[i + 1] : buf.length);

  const r0 = rec(0);
  const d0 = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = d0.getUint16(0);
  const textLength = d0.getUint32(4);
  const textRecords = d0.getUint16(8);
  const encryption = d0.getUint16(12);
  if (encryption) throw new BookError('This Kindle book is copy-protected (DRM), so it can\'t be opened here.');
  if (compression === 17480) throw new BookError('This Kindle book uses a kind of compression that isn\'t supported. Convert it to EPUB (for example with Calibre).');

  let title = ascii(0, 32).replace(/\0.*$/s, '').replace(/_/g, ' ');
  let author = '';
  let lang = '';
  let encoding = 1252;
  let firstImage = -1;
  let extraFlags = 0;
  let coverIndex = -1;
  const isMobi = r0.length > 20 && new TextDecoder('latin1').decode(r0.subarray(16, 20)) === 'MOBI';
  if (isMobi) {
    const headerLen = d0.getUint32(20);
    encoding = d0.getUint32(28);
    const version = d0.getUint32(36);
    const dec = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252');
    const nameOff = d0.getUint32(0x54);
    const nameLen = d0.getUint32(0x58);
    if (nameLen && nameOff + nameLen <= r0.length) title = dec.decode(r0.subarray(nameOff, nameOff + nameLen));
    if (headerLen >= 0x5c) firstImage = d0.getUint32(0x6c);
    if (headerLen >= 0xe4) extraFlags = d0.getUint16(0xf2);
    if (d0.getUint32(0x80) & 0x40) {
      let p = 16 + headerLen;
      if (new TextDecoder('latin1').decode(r0.subarray(p, p + 4)) === 'EXTH') {
        const n = d0.getUint32(p + 8);
        p += 12;
        for (let k = 0; k < n && p + 8 <= r0.length; k++) {
          const type = d0.getUint32(p);
          const len = d0.getUint32(p + 4);
          const data = r0.subarray(p + 8, p + len);
          if (type === 100 && !author) author = dec.decode(data).trim();
          else if (type === 503) title = dec.decode(data).trim() || title;
          else if (type === 524) lang = dec.decode(data).trim();
          else if (type === 201 && data.length >= 4) coverIndex = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
          p += Math.max(8, len);
        }
      }
    }
    if (version >= 8) throw new BookError('AZW3 (KF8) Kindle books aren\'t supported yet. Convert it to EPUB (for example with Calibre), then add the EPUB.');
  }

  // Put the text together.
  const parts = [];
  let total = 0;
  for (let i = 1; i <= textRecords && i < count && total < textLength; i++) {
    let data = rec(i);
    if (extraFlags) data = data.subarray(0, Math.max(0, data.length - trailingSize(data, extraFlags)));
    const plain = compression === 2 ? palmDoc(data) : data;
    parts.push(plain);
    total += plain.length;
  }
  let bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  bytes = bytes.subarray(0, Math.min(total, textLength || total));

  // Links inside the book point at byte positions ("filepos"). Drop an anchor at each one.
  const raw = new TextDecoder('latin1').decode(bytes);
  const targets = [...new Set([...raw.matchAll(/filepos\s*=\s*["']?(\d+)/gi)].map((m) => +m[1]))]
    .filter((n) => n < bytes.length).sort((a, b) => b - a);
  if (targets.length) {
    const pieces = [];
    let end = bytes.length;
    const enc = new TextEncoder();
    for (const t of targets) { pieces.unshift(enc.encode(`<a id="filepos${t}"></a>`), bytes.subarray(t, end)); end = t; }
    pieces.unshift(bytes.subarray(0, end));
    const merged = new Uint8Array(pieces.reduce((s, p) => s + p.length, 0));
    let q = 0;
    for (const p of pieces) { merged.set(p, q); q += p.length; }
    bytes = merged;
  }
  let html = new TextDecoder(encoding === 65001 ? 'utf-8' : 'windows-1252').decode(bytes);
  html = html
    .replace(/<img\b([^>]*?)\s(?:recindex|hirecindex|lorecindex)\s*=\s*["']?(\d+)["']?([^>]*)>/gi, (m, a, n, b) => `<img${a} src="rec/${+n}"${b}>`)
    .replace(/\sfilepos\s*=\s*["']?(\d+)["']?/gi, (m, n) => ` href="#filepos${+n}"`);

  const chunks = splitBig(html.split(/<mbp:pagebreak\s*\/?>/i).filter((c) => /\S/.test(c.replace(/<[^>]+>/g, ''))
    || /<img/i.test(c)));
  return htmlBook({
    format: 'mobi', title, author, lang,
    chunks,
    image(ref) {
      const n = Number(ref);
      if (firstImage < 0 || !(n >= 1)) return null;
      const i = firstImage + n - 1;
      if (i >= count) return null;
      const data = rec(i);
      const type = imageType(data);
      return type ? new Blob([data], { type }) : null;
    },
    cover: coverIndex >= 0 ? `rec/${coverIndex + 1}` : null,
  });
}

// Very long chapters are slow to lay out on a phone, so they're cut at a paragraph.
function splitBig(chunks, max = 150000) {
  const out = [];
  for (const c of chunks) {
    if (c.length <= max) { out.push(c); continue; }
    let start = 0;
    while (c.length - start > max) {
      let cut = c.indexOf('</p>', start + max * 0.7);
      if (cut < 0 || cut > start + max * 1.5) cut = c.indexOf('>', start + max);
      if (cut < 0) break;
      cut = c.indexOf('>', cut) + 1;
      out.push(c.slice(start, cut));
      start = cut;
    }
    out.push(c.slice(start));
  }
  return out;
}

// A book made from plain HTML chunks (MOBI, FB2, TXT). Pictures are found by a resolver.
function htmlBook({ format, title, author, lang, chunks, image, cover, ids }) {
  const chapters = chunks.map((c, i) => ({ href: `ch${i + 1}.html`, size: c.length || 1 }));
  const toc = [];
  chunks.forEach((c, i) => {
    const m = c.match(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/i);
    const t = m && m[2].replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (t) toc.push({ title: t.length > 90 ? `${t.slice(0, 88)}…` : t, href: chapters[i].href, depth: 0 });
  });
  // Notes and links that point to an id in another chapter.
  const idMap = new Map();
  chunks.forEach((c, i) => { for (const m of c.matchAll(/\sid\s*=\s*["']([^"']+)["']/gi)) if (!idMap.has(m[1])) idMap.set(m[1], i); });
  if (ids) for (const [k, v] of ids) idMap.set(k, v);
  const getBlob = async (p) => {
    const m = p.match(/^(?:rec|bin)\/(.+)$/);
    return m ? image(decodeURIComponent(m[1])) : null;
  };
  const cache = urlCache(getBlob);
  return {
    format, title, author, lang, rtl: false, fixed: false,
    chapters, toc, ids: idMap,
    coverPath: cover,
    async load(i) { return { text: `<html><body>${chunks[i]}</body></html>`, type: 'html' }; },
    blob: getBlob,
    text: async () => null,
    url: cache.url,
    close: cache.close,
  };
}

// ---------- FB2 (FictionBook) ----------
const XLINK = 'http://www.w3.org/1999/xlink';
const hrefOf = (el) => el.getAttributeNS(XLINK, 'href') || el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttribute('href') || '';

async function openFb2(blob) {
  checkSize(blob, 'book');
  const text = decodeText(new Uint8Array(await blob.arrayBuffer()));
  const doc = parseXml(text) || new DOMParser().parseFromString(text, 'text/html');
  const first = (root, name) => (root ? byLocal(root, name)[0] : null);
  const info = first(doc, 'title-info');
  const authorEl = first(info, 'author');
  const author = authorEl
    ? ['first-name', 'middle-name', 'last-name'].map((n) => first(authorEl, n)?.textContent.trim()).filter(Boolean).join(' ')
      || first(authorEl, 'nickname')?.textContent.trim() || ''
    : '';
  const binaries = new Map(byLocal(doc, 'binary').map((b) => [b.getAttribute('id'), b]));
  const coverImg = first(first(info, 'coverpage'), 'image');

  const chunks = [];
  const convert = (node, depth) => {
    if (node.nodeType === 3) return esc(node.nodeValue);
    if (node.nodeType !== 1) return '';
    const kids = () => [...node.childNodes].map((c) => convert(c, depth)).join('');
    const id = node.getAttribute('id');
    const idAttr = id ? ` id="${esc(id)}"` : '';
    switch (node.localName) {
      case 'section': return `<section${idAttr}>${[...node.childNodes].map((c) => convert(c, depth + 1)).join('')}</section>`;
      case 'title': {
        const lines = [...node.children].map((c) => [...c.childNodes].map((x) => convert(x, depth)).join('')).filter(Boolean);
        const h = Math.min(6, depth + 1);
        return `<h${h} class="title"${idAttr}>${lines.join('<br>') || kids()}</h${h}>`;
      }
      case 'subtitle': return `<h${Math.min(6, depth + 2)} class="subtitle"${idAttr}>${kids()}</h${Math.min(6, depth + 2)}>`;
      case 'p': return `<p${idAttr}>${kids()}</p>`;
      case 'emphasis': return `<em>${kids()}</em>`;
      case 'strong': return `<strong>${kids()}</strong>`;
      case 'strikethrough': return `<s>${kids()}</s>`;
      case 'sub': case 'sup': case 'code': return `<${node.localName}>${kids()}</${node.localName}>`;
      case 'empty-line': return '<p class="empty">&#160;</p>';
      case 'epigraph': return `<blockquote class="epigraph"${idAttr}>${kids()}</blockquote>`;
      case 'cite': return `<blockquote${idAttr}>${kids()}</blockquote>`;
      case 'text-author': return `<p class="text-author">${kids()}</p>`;
      case 'poem': return `<div class="poem"${idAttr}>${kids()}</div>`;
      case 'stanza': return `<div class="stanza">${kids()}</div>`;
      case 'v': return `<p class="verse">${kids()}</p>`;
      case 'image': {
        const ref = hrefOf(node).replace(/^#/, '');
        return ref ? `<div class="image"${idAttr}><img src="bin/${encodeURIComponent(ref)}" alt=""></div>` : '';
      }
      case 'a': {
        const href = hrefOf(node);
        return `<a href="${esc(href)}"${node.getAttribute('type') === 'note' ? ' class="note"' : ''}>${kids()}</a>`;
      }
      case 'table': case 'tr': case 'td': case 'th': {
        const span = ['colspan', 'rowspan'].map((a) => (node.getAttribute(a) ? ` ${a}="${esc(node.getAttribute(a))}"` : '')).join('');
        return `<${node.localName}${span}>${kids()}</${node.localName}>`;
      }
      case 'binary': case 'description': return '';
      default: return kids();
    }
  };

  const bodies = byLocal(doc, 'body');
  const main = bodies.find((b) => !b.getAttribute('name')) || bodies[0];
  if (!main) throw new BookError('This FB2 book has no text inside.');
  // Each top-level section is a chapter. Whatever comes before the first one (the book's title,
  // an epigraph) goes at the start of the first chapter.
  let front = '';
  const chapterize = (section, depth, prefix) => {
    const subs = [...section.children].filter((c) => c.localName === 'section');
    const size = section.textContent.length;
    if (size > 120000 && subs.length > 1) {
      let head = prefix;
      for (const c of section.children) if (c.localName !== 'section') head += convert(c, depth + 1);
      subs.forEach((s, i) => chapterize(s, depth + 1, i ? '' : head));
      return;
    }
    chunks.push(prefix + convert(section, depth));
  };
  for (const c of main.children) {
    if (c.localName === 'section') { chapterize(c, 0, front); front = ''; }
    else front += convert(c, 0);
  }
  if (front) chunks.push(front);
  for (const b of bodies) {
    if (b === main) continue;
    const label = first(b, 'title') ? '' : `<h1>${b.getAttribute('name') === 'notes' ? 'Notes' : 'More'}</h1>`;
    chunks.push(label + convert(b, 0));
  }

  return htmlBook({
    format: 'fb2',
    title: first(info, 'book-title')?.textContent.trim() || '',
    author,
    lang: first(info, 'lang')?.textContent.trim() || '',
    chunks,
    image(id) {
      const b = binaries.get(id);
      if (!b) return null;
      try {
        const bin = atob(b.textContent.replace(/\s+/g, ''));
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: b.getAttribute('content-type') || imageType(arr) || 'image/jpeg' });
      } catch { return null; }
    },
    cover: coverImg ? `bin/${encodeURIComponent(hrefOf(coverImg).replace(/^#/, ''))}` : null,
  });
}

// ---------- TXT ----------
const HEADING_RE = /^\s{0,10}((chapter|chap\.|cap[ií]tulo|chapitre|kapitel|capitolo|part|parte|partie|teil|book|libro|livre|prologue|pr[oó]logo|epilogue|ep[ií]logo|introduction|introducci[oó]n|preface|prefacio|afterword)\b.{0,70}|(\d{1,3}|[IVXLC]{1,7})\.?)\s*$/i;

async function openTxt(blob, name) {
  checkSize(blob, 'text file');
  const text = decodeText(new Uint8Array(await blob.arrayBuffer())).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const lines = text.split('\n');
  // Split into chapters at lines that look like headings, with a blank line before them.
  const sections = [{ heading: '', lines: [] }];
  lines.forEach((line, i) => {
    const blankBefore = i === 0 || !lines[i - 1].trim();
    const blankAfter = i + 1 >= lines.length || !lines[i + 1].trim() || HEADING_RE.test(lines[i + 1]);
    if (blankBefore && blankAfter && line.trim() && HEADING_RE.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  });
  const blankLines = /\n[ \t]*\n/.test(text);
  const toHtml = (ls) => {
    if (!blankLines) return ls.filter((l) => l.trim()).map((l) => `<p>${esc(l.trim())}</p>`);
    const out = [];
    let block = [];
    const flush = () => {
      if (!block.length) return;
      // Short lines (poems, addresses) keep their line breaks; wrapped prose is joined up.
      const keepBreaks = block.length > 1 && Math.max(...block.map((l) => l.trim().length)) < 55;
      out.push(`<p>${block.map((l) => esc(l.trim())).join(keepBreaks ? '<br>' : ' ')}</p>`);
      block = [];
    };
    for (const l of ls) { if (l.trim()) block.push(l); else flush(); }
    flush();
    return out;
  };
  const chunks = [];
  for (const s of sections) {
    const paras = toHtml(s.lines);
    if (!s.heading && !paras.length) continue;
    // Keep chapters to a size a phone lays out quickly.
    let cur = s.heading ? `<h2>${esc(s.heading)}</h2>` : '';
    for (const p of paras) {
      if (cur.length > 60000) { chunks.push(cur); cur = ''; }
      cur += p;
    }
    if (cur) chunks.push(cur);
  }
  if (!chunks.length) throw new BookError(`${name || 'This text file'} is empty.`);
  return htmlBook({ format: 'txt', title: '', author: '', lang: '', chunks, image: () => null, cover: null });
}

// ---------- opening ----------
export async function openTextBook(blob, format, name = '') {
  if (format === 'epub') return openEpub(blob);
  if (format === 'mobi') return openMobi(blob);
  if (format === 'fb2') return openFb2(blob);
  if (format === 'txt') return openTxt(blob, name);
  throw new BookError('Unknown book format.');
}

export function bookFormatFor(ext) {
  if (ext === 'epub') return 'epub';
  if (['mobi', 'prc', 'azw', 'azw3'].includes(ext)) return 'mobi';
  if (ext === 'fb2') return 'fb2';
  if (ext === 'txt') return 'txt';
  return null;
}

// Reads what the library needs when a book is added. Returns null for an EPUB that is
// really a comic (pictures only), so it can be added as one instead.
export async function bookInfo(file, format) {
  const book = await openTextBook(file, format, file.name);
  try {
    if (format === 'epub' && !(await epubHasText(book))) return null;
    let cover = null;
    if (book.coverPath) cover = await book.blob(book.coverPath).catch(() => null);
    if (!cover && format === 'epub') {
      // No cover marked: use a picture on the first page, if it has one.
      try {
        const { text } = await book.load(0);
        const m = text.match(/<(?:img|image)\b[^>]*?(?:src|xlink:href|href)\s*=\s*["']([^"']+)["']/i);
        if (m) cover = await book.blob(resolvePath(book.chapters[0].href, m[1]));
      } catch { cover = null; }
    }
    return {
      title: book.title.replace(/\s+/g, ' ').trim().slice(0, 200),
      author: book.author.replace(/\s+/g, ' ').trim().slice(0, 200),
      chapters: book.chapters.length,
      cover: cover && cover.size ? cover : null,
    };
  } finally {
    book.close();
  }
}

// A plain cover for books that don't have a picture: the title on a coloured card.
const COVER_COLORS = ['#b3261e', '#1f4e8c', '#2e6b3a', '#7a3e8f', '#a35a12', '#22666b', '#5b5b5b', '#8c1d4f'];
export async function plainCover(title, author) {
  const w = 400;
  const h = 600;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = COVER_COLORS[hash % COVER_COLORS.length];
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.18)';
  ctx.fillRect(0, 0, 26, h);
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 3;
  ctx.strokeRect(52, 52, w - 80, h - 104);
  try { await document.fonts?.load('800 40px "Barlow Condensed"'); } catch { /* use a fallback font */ }
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  const wrap = (text, font, size, maxLines) => {
    ctx.font = `${font} ${size}px "Barlow Condensed", "Avenir Next Condensed", "Arial Narrow", sans-serif`;
    const words = text.split(/\s+/);
    const out = [];
    let line = '';
    for (const word of words) {
      const t = line ? `${line} ${word}` : word;
      if (ctx.measureText(t).width > w - 130 && line) { out.push(line); line = word; } else line = t;
    }
    if (line) out.push(line);
    if (out.length > maxLines) { out.length = maxLines; out[maxLines - 1] += '…'; }
    return out;
  };
  const titleLines = wrap(title.toUpperCase(), '800', 54, 6);
  let y = 150;
  for (const l of titleLines) { ctx.fillText(l, w / 2 + 13, y); y += 58; }
  if (author) {
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    const lines = wrap(author, '600', 30, 2);
    let ay = h - 110 - (lines.length - 1) * 34;
    for (const l of lines) { ctx.fillText(l, w / 2 + 13, ay); ay += 34; }
  }
  const cover = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
  return { cover, color, ratio: h / w };
}

// ---------- getting a chapter ready to show ----------
// Parses the chapter, removes scripts, inlines its stylesheets and points pictures, fonts and
// links at the files inside the book. The reader then copies the result into its page.
export async function loadChapter(book, i) {
  const ch = book.chapters[i];
  const base = ch.href;
  const { text, type } = await book.load(i);
  let doc = null;
  if (type === 'xhtml') {
    doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.body) doc = null;
  }
  if (!doc) doc = new DOMParser().parseFromString(text, 'text/html');

  doc.querySelectorAll('script, noscript, iframe, object, embed, form, base, meta, title').forEach((e) => e.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }

  const styles = [];
  for (const el of [...doc.querySelectorAll('link, style')]) {
    if (el.localName === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const href = el.getAttribute('href');
      if (/stylesheet/.test(rel) && !/alternate/.test(rel) && href && !isExternal(href)) {
        const path = resolvePath(base, href);
        const css = await book.text(path).catch(() => null);
        if (css) styles.push(await rewriteCss(book, css, path));
      }
    } else {
      styles.push(await rewriteCss(book, el.textContent || '', base));
    }
    el.remove();
  }

  const swap = async (el, attr, ns) => {
    const v = ns ? el.getAttributeNS(ns, attr) || el.getAttribute(`xlink:${attr}`) : el.getAttribute(attr);
    if (!v || isExternal(v) || v.startsWith('#')) {
      if (v && /^(https?|ftp):/i.test(v)) el.removeAttribute(attr); // never load anything from the internet
      return;
    }
    const url = await book.url(resolvePath(base, v));
    if (ns) { el.removeAttributeNS(ns, attr); el.removeAttribute(`xlink:${attr}`); el.setAttribute('href', url); } else el.setAttribute(attr, url);
  };
  const jobs = [];
  for (const el of doc.querySelectorAll('img, video, audio, source, track, input')) {
    el.removeAttribute('srcset');
    jobs.push(swap(el, 'src'));
    if (el.hasAttribute('poster')) jobs.push(swap(el, 'poster'));
  }
  for (const el of doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')) {
    jobs.push(el.hasAttribute('href') ? swap(el, 'href') : swap(el, 'href', XLINK));
  }
  await Promise.all(jobs);
  for (const el of doc.querySelectorAll('[style]')) {
    const s = el.getAttribute('style');
    if (/url\(/i.test(s)) el.setAttribute('style', await rewriteCss(book, s, base));
  }

  // Links: remember where each one goes inside the book; the reader follows them when tapped.
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    const href = a.getAttribute('href');
    if (isExternal(href)) a.setAttribute('data-cb-out', href);
    else a.setAttribute('data-cb-href', href.startsWith('#') ? `${base}${href}` : resolvePath(base, href) + (fragOf(href) ? `#${fragOf(href)}` : ''));
  }

  const htmlEl = doc.documentElement;
  const lang = htmlEl.getAttribute('lang') || htmlEl.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') || htmlEl.getAttribute('xml:lang') || book.lang || '';
  return { doc, styles, base, lang, dir: htmlEl.getAttribute('dir') || doc.body?.getAttribute('dir') || '' };
}

async function rewriteCss(book, css, base, depth = 0) {
  // Stylesheets that include other stylesheets.
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)];
  for (const m of imports) {
    let inner = '';
    if (depth < 3 && !isExternal(m[1])) {
      const p = resolvePath(base, m[1]);
      inner = await rewriteCss(book, (await book.text(p).catch(() => null)) || '', p, depth + 1);
    }
    css = css.replace(m[0], inner);
  }
  const found = new Map();
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const ref = m[2].trim();
    if (!found.has(ref) && !/^(data|blob):/i.test(ref) && !ref.startsWith('#')) {
      found.set(ref, isExternal(ref) ? Promise.resolve('') : book.url(resolvePath(base, ref)));
    }
  }
  const urls = new Map();
  for (const [k, v] of found) urls.set(k, await v);
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, ref) => {
    const u = urls.get(ref.trim());
    return u === undefined ? m : `url("${u || 'about:invalid'}")`;
  });
}
