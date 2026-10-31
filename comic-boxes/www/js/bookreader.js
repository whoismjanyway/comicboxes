// The book reader: EPUB, MOBI, FB2 and TXT books, laid out by the browser so the reader can
// choose the font, text size, line spacing, margins, alignment, page colour, and pages or scrolling.
//
// Each chapter is shown in an <iframe> (sandboxed: the book's own scripts never run) so the
// book's styles can't touch the app. In page mode the chapter is laid out in columns one screen
// wide, the iframe is made as wide as all of them, and turning a page slides it sideways.
// Taps and swipes land on a clear layer above the iframe, which works the same on every browser.

import * as db from './db.js';
import { openTextBook, loadChapter, fragOf } from './book.js';
import { bookPrefs, BOOK_DEFAULTS, readerPref } from './settings.js';

const THEMES = {
  white: { label: 'White', bg: '#ffffff', fg: '#1c1c1c', muted: '#8a8a8a', link: '#1a5fb4', sel: 'rgba(26,95,180,.25)', recolor: false },
  sepia: { label: 'Sepia', bg: '#f4ecd8', fg: '#433422', muted: '#958063', link: '#8a4b12', sel: 'rgba(138,75,18,.25)', recolor: true },
  gray: { label: 'Gray', bg: '#3a3c3f', fg: '#e6e4df', muted: '#a09e99', link: '#a8c8ff', sel: 'rgba(168,200,255,.3)', recolor: true },
  black: { label: 'Black', bg: '#000000', fg: '#cccccc', muted: '#6f6f6f', link: '#8ab4f8', sel: 'rgba(138,180,248,.3)', recolor: true },
};
const FONTS = {
  original: { label: 'Book', stack: null },
  serif: { label: 'Serif', stack: '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, Cambria, "Times New Roman", serif' },
  sans: { label: 'Sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  rounded: { label: 'Rounded', stack: 'ui-rounded, "SF Pro Rounded", Nunito, "Varela Round", "Arial Rounded MT Bold", system-ui, sans-serif' },
  mono: { label: 'Mono', stack: 'ui-monospace, "SF Mono", Menlo, Consolas, "Roboto Mono", "Courier New", monospace' },
};
const SPACING = { tight: 1.3, normal: 1.55, loose: 1.85 };
const MARGINS = { narrow: 12, normal: 24, wide: 42 };
const SIZE_MIN = 60;
const SIZE_MAX = 250;
const SIZE_STEP = 10;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

export class BookReader {
  constructor({ onClose }) {
    this.onClose = onClose;
    const $ = (id) => document.getElementById(id);
    this.root = $('bookReader');
    this.stage = $('bookStage');
    this.clip = $('bookClip');
    this.sheet = $('bookSheet');
    this.frame = $('bookFrame');
    this.touch = $('bookTouch');
    this.loadingEl = $('bookLoading');
    this.statusLeft = $('bookStatusLeft');
    this.statusRight = $('bookStatusRight');
    this.prevChBtn = $('bookPrevCh');
    this.nextChBtn = $('bookNextCh');
    this.backBtn = $('bookBack');
    this.titleEl = $('bookTitle');
    this.whereEl = $('bookWhere');
    this.pageEl = $('bookPage');
    this.slider = $('bookSlider');
    this.pctEl = $('bookPct');
    this.panel = $('bookPanel');
    this.tocPanel = $('bookToc');
    this.aaBtn = $('bookAaBtn');
    this.tocBtn = $('bookTocBtn');

    this.isOpen = false;
    this.book = null;
    this.ch = -1;
    this.page = 0;
    this.pages = 1;
    this.chrome = true;

    // One blank page, made once; every chapter is copied into it.
    this.frameReady = new Promise((resolve) => this.frame.addEventListener('load', resolve, { once: true }));
    this.frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';

    $('closeBook').addEventListener('click', () => this.onClose());
    this.aaBtn.addEventListener('click', () => this.togglePanel('aa'));
    this.tocBtn.addEventListener('click', () => this.togglePanel('toc'));
    this.prevChBtn.addEventListener('click', () => { if (this.ch > 0) this.goTo(this.ch - 1, { end: true }); });
    this.nextChBtn.addEventListener('click', () => { if (this.ch < this.book.chapters.length - 1) this.goTo(this.ch + 1, {}); });
    this.backBtn.addEventListener('click', () => {
      const b = this.backTo;
      this.hideBack();
      if (b) this.goTo(b.ch, { frac: b.frac });
    });

    this.slider.addEventListener('input', () => {
      const at = this.locateOverall(+this.slider.value / 1000);
      this.pctEl.textContent = `${Math.round(+this.slider.value / 10)}%`;
      this.whereEl.textContent = this.chapterTitle(at.ch);
      this.pageEl.textContent = '';
    });
    this.slider.addEventListener('change', () => {
      const at = this.locateOverall(+this.slider.value / 1000);
      this.goTo(at.ch, { frac: at.frac });
    });

    this.touch.addEventListener('pointerdown', (e) => this.down(e));
    this.touch.addEventListener('pointermove', (e) => this.move(e));
    this.touch.addEventListener('pointerup', (e) => this.up(e));
    this.touch.addEventListener('pointercancel', () => this.cancelGesture());
    this.touch.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.clip.addEventListener('scroll', () => { if (this.scroll && this.isOpen && this.doc) this.moved(); }, { passive: true });
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('resize', () => {
      if (!this.isOpen) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.relayout(), 150);
    });
  }

  // ---------- open / close ----------
  async open(comic) {
    if (this.isOpen && this.comic && this.comic.id === comic.id) return;
    if (this.isOpen) this.close();
    this.comic = comic;
    this.isOpen = true;
    this.root.hidden = false;
    this.titleEl.textContent = comic.name;
    this.tapTurn = readerPref.get('tapTurn', true);
    this.keepAwake(readerPref.get('awake', false));
    this.closePanels();
    this.hideBack();
    this.setChrome(true);
    this.applyColors();
    this.showLoading(true);

    const file = await db.get('files', comic.id);
    if (!file) throw new Error('file missing');
    await this.frameReady;
    const book = await openTextBook(file.blob, comic.format, comic.name);
    if (!this.isOpen || this.comic !== comic) { book.close(); return; }
    if (!book.chapters.length) { book.close(); throw new Error('no chapters'); }
    this.book = book;
    this.cum = [];
    let total = 0;
    for (const c of book.chapters) { this.cum.push(total); total += c.size; }
    this.total = total || 1;
    this.byHref = new Map();
    book.chapters.forEach((c, i) => { this.byHref.set(c.href, i); this.byHref.set(c.href.toLowerCase(), i); });
    this.toc = book.toc.map((t) => ({ ...t, ch: this.chapterOf(t.href.split('#')[0]) })).filter((t) => t.ch >= 0);

    const start = comic.done ? 0 : clamp(comic.lastPage || 0, 0, book.chapters.length - 1);
    await this.goTo(start, { frac: comic.done ? 0 : comic.chPos || 0 });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.token = null;
    this.keepAwake(false);
    this.closePanels();
    try {
      const d = this.frame.contentDocument;
      d?.head.replaceChildren();
      d?.body.replaceChildren();
    } catch { /* not ready yet */ }
    this.doc = null;
    this.ch = -1;
    try { this.book?.close(); } catch { /* already closed */ }
    this.book = null;
  }

  chapterOf(path) {
    if (this.byHref.has(path)) return this.byHref.get(path);
    const lower = path.toLowerCase();
    return this.byHref.has(lower) ? this.byHref.get(lower) : -1;
  }

  // ---------- going to a place in the book ----------
  // where: { frac } a fraction of the chapter, { end: true } its last page, { frag } an id in it.
  async goTo(ch, where = {}) {
    if (!this.book) return;
    ch = clamp(ch, 0, this.book.chapters.length - 1);
    const token = (this.token = Symbol('chapter'));
    if (ch !== this.ch || !this.doc) {
      this.showLoading(true);
      let data = null;
      try { data = await loadChapter(this.book, ch); } catch (e) { console.warn(e); }
      if (token !== this.token || !this.isOpen) return;
      this.fill(data);
      this.ch = ch;
      await this.waitForMedia();
      if (token !== this.token || !this.isOpen) return;
      this.layout();
      this.recheckLater();
    }
    this.showLoading(false);
    this.updateChapterButtons();
    if (where.frag && this.placeFragment(where.frag)) return;
    if (where.end) this.setFrac(1);
    else this.setFrac(where.frac || 0);
  }

  // Copies a prepared chapter into the reader's page.
  fill(data) {
    const d = this.frame.contentDocument;
    this.doc = d;
    for (const node of [d.documentElement, d.body]) for (const a of [...node.attributes]) node.removeAttribute(a.name);
    d.head.replaceChildren();
    d.body.replaceChildren();
    const styleEl = d.createElement('style');
    if (!data) {
      d.body.append(Object.assign(d.createElement('p'), { textContent: 'This part of the book couldn\'t be opened.' }));
    } else {
      const src = data.doc;
      for (const name of ['class', 'style']) {
        const v = src.documentElement.getAttribute(name);
        if (v) d.documentElement.setAttribute(name, v);
      }
      if (data.lang) d.documentElement.setAttribute('lang', data.lang);
      const body = src.body || src.documentElement;
      for (const a of [...body.attributes]) {
        if (['class', 'id', 'style', 'dir', 'lang'].includes(a.name)) d.body.setAttribute(a.name, a.value);
      }
      for (const css of data.styles) d.head.append(Object.assign(d.createElement('style'), { textContent: css }));
      for (const n of [...body.childNodes]) d.body.append(d.importNode(n, true));
    }
    d.head.append(styleEl);
    this.styleEl = styleEl;
    // The book's own text direction (right-to-left languages), before the reader's styles apply.
    this.dir = data?.dir || d.defaultView.getComputedStyle(d.body).direction || 'ltr';
    if (this.dir !== 'rtl') this.dir = 'ltr';
  }

  async waitForMedia() {
    const d = this.doc;
    const imgs = [...d.images].filter((i) => i.getAttribute('src'));
    const pics = Promise.allSettled(imgs.map((i) => i.decode()));
    const fonts = d.fonts ? d.fonts.ready.catch(() => {}) : null;
    await Promise.race([Promise.all([pics, fonts]), wait(2500)]);
  }

  // Pictures and fonts that arrive late can change the length of a chapter.
  recheckLater() {
    const d = this.doc;
    clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => {
      if (!this.isOpen || this.doc !== d) return;
      const before = this.scroll ? this.frame.offsetHeight : this.pages;
      const after = this.scroll ? d.documentElement.scrollHeight : this.measurePages();
      if (Math.abs(after - before) > (this.scroll ? 4 : 0)) this.relayout();
    }, 1500);
  }

  // ---------- layout ----------
  geometry() {
    const p = this.prefs;
    const W = Math.max(200, Math.floor(this.stage.clientWidth));
    const H = Math.max(200, Math.floor(this.stage.clientHeight));
    const m = MARGINS[p.margins] * (W >= 700 ? 1.6 : 1);
    // Lines longer than about 36 words' width are tiring, so wide screens get wider margins.
    const maxCol = Math.round(620 * (p.size / 100));
    const cols = !this.scroll && p.columns && W >= 800 && W > H * 1.15 ? 2 : 1;
    let mh = m;
    if (cols === 1 && W - 2 * m > maxCol) mh = (W - maxCol) / 2;
    if (cols === 2 && (W - 4 * m) / 2 > maxCol) mh = (W - 2 * maxCol) / 4;
    mh = Math.floor(mh);
    const colW = cols === 1 ? W - 2 * mh : (W - 4 * mh) / 2;
    const top = this.scroll ? 28 : Math.round(Math.max(22, m * 0.9) + 8);
    const bottom = this.scroll ? 40 : top + 18; // room for the page number line
    return { W, H, mh, colW, cols, top, bottom };
  }

  css() {
    const { W, H, mh, colW, cols, top, bottom } = this.g;
    const p = this.prefs;
    const t = THEMES[bookPrefs.theme()];
    const font = FONTS[p.font]?.stack;
    const lh = SPACING[p.spacing] || SPACING.normal;
    const textH = H - top - bottom;
    const paged = this.scroll
      ? 'height:auto !important; min-height:0 !important; max-height:none !important; column-count:auto !important; column-width:auto !important;'
      : `height:${H}px !important; min-height:0 !important; max-height:none !important; column-width:${colW}px !important; column-count:${cols} !important; column-gap:${2 * mh}px !important; column-fill:auto !important;`;
    let css = `
html { margin:0 !important; padding:0 !important; border:0 !important; width:auto !important; height:auto !important; max-width:none !important; min-width:0 !important;
  overflow:hidden !important; background:${t.bg} !important; color:${t.fg}; font-size:${p.size}% !important;
  -webkit-text-size-adjust:100% !important; text-size-adjust:100% !important; writing-mode:horizontal-tb !important; }
body { margin:0 !important; border:0 !important; box-sizing:border-box !important; width:${W}px !important; max-width:none !important; min-width:0 !important;
  padding:${top}px ${mh}px ${bottom}px !important; background:transparent !important; direction:ltr !important; overflow:visible !important;
  position:static !important; transform:none !important; float:none !important; ${paged} }
body > * { direction:${this.dir}; }
img, svg, video, canvas, object, embed { max-width:100% !important; max-height:${this.scroll ? Math.round(H * 0.92) : textH}px !important; box-sizing:border-box !important; object-fit:contain; }
img { height:auto; }
img, svg, figure, table, tr { break-inside:avoid; -webkit-column-break-inside:avoid; }
h1, h2, h3, h4, h5, h6 { break-after:avoid; -webkit-column-break-after:avoid; }
pre { white-space:pre-wrap !important; overflow-wrap:anywhere; }
table { max-width:100% !important; }
[style*="position: fixed"], [style*="position:fixed"] { position:static !important; }
::selection { background:${t.sel}; }
html body p.empty { margin:0 !important; }
html body .poem { margin:1em 0 1em 2em; }
html body .epigraph { margin:1em 0 1em 25%; font-style:italic; }
html body .text-author { text-align:right; font-style:italic; }
html body a.note { vertical-align:super; font-size:.75em; text-decoration:none; }
html body, html body p, html body li, html body blockquote, html body dd, html body dt, html body div, html body span, html body td, html body th, html body section { line-height:${lh} !important; }
html body h1, html body h2, html body h3, html body h4, html body h5, html body h6 { line-height:1.25 !important; }
html body a, html body a * { color:${t.link} !important; }
`;
    if (font) css += `html body, html body *:not(code):not(pre):not(kbd):not(samp):not(tt):not(var) { font-family:${font} !important; }\n`;
    if (p.align === 'justify') {
      css += 'html body p, html body li, html body blockquote, html body dd { text-align:justify !important; -webkit-hyphens:auto !important; hyphens:auto !important; }\n';
    } else if (p.align === 'left') {
      css += 'html body p, html body li, html body blockquote, html body dd { text-align:start !important; -webkit-hyphens:manual !important; hyphens:manual !important; }\n';
    }
    if (t.recolor) {
      css += `html body, html body *:not(img):not(svg):not(video) { color:${t.fg} !important; background-color:transparent !important; border-color:${t.muted} !important; }
html body a, html body a * { color:${t.link} !important; }
html body hr { border-color:${t.muted} !important; background-color:${t.muted} !important; }\n`;
    } else {
      css += `html body { color:${t.fg}; }\n`;
    }
    return css;
  }

  measurePages() {
    const d = this.doc;
    const W = this.g.W;
    const sw = Math.max(d.documentElement.scrollWidth, d.body.scrollWidth);
    return Math.max(1, Math.ceil((sw - 2) / W));
  }

  layout() {
    const d = this.doc;
    if (!d) return;
    this.prefs = { ...bookPrefs.all() };
    this.scroll = this.prefs.layout === 'scroll';
    this.root.classList.toggle('scrolling', this.scroll);
    this.g = this.geometry();
    this.styleEl.textContent = this.css();
    const { W, H } = this.g;
    const f = this.frame.style;
    f.transition = 'none';
    f.transform = '';
    f.width = `${W}px`;
    f.height = `${H}px`;
    if (this.scroll) {
      const h = Math.max(Math.round(H * 0.5), d.documentElement.scrollHeight, d.body.scrollHeight);
      f.height = `${h}px`;
      this.pages = 1;
    } else {
      this.pages = this.measurePages();
      f.width = `${this.pages * W}px`;
    }
    this.sheet.style.width = `${W}px`;
  }

  // Lays the chapter out again (new settings or a new screen size) and stays on the same text.
  relayout() {
    if (!this.doc || !this.book) return;
    const anchor = this.captureAnchor();
    const frac = this.chapterFrac();
    this.layout();
    this.updateChapterButtons();
    const at = anchor && this.locate(anchor);
    if (at) this.place(at); else this.setFrac(frac);
  }

  // A text position at the top of what's on screen: the word that should stay there.
  captureAnchor() {
    const d = this.doc;
    const g = this.g;
    if (!d || !g) return null;
    const x = (this.scroll ? 0 : this.page * g.W) + g.mh + 3;
    const y = (this.scroll ? Math.max(0, this.clip.scrollTop - this.sheet.offsetTop) : 0) + g.top + 3;
    try {
      if (d.caretPositionFromPoint) {
        const cp = d.caretPositionFromPoint(x, y);
        if (cp && cp.offsetNode) { const r = d.createRange(); r.setStart(cp.offsetNode, cp.offset); return r; }
      }
      if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y);
    } catch { /* not supported */ }
    return null;
  }

  rectOf(range) {
    let rect = range.getClientRects()[0];
    if (!rect || (!rect.width && !rect.height)) {
      const n = range.startContainer;
      if (n.nodeType === 3 && range.startOffset < n.length) {
        const r2 = range.cloneRange();
        r2.setEnd(n, range.startOffset + 1);
        rect = r2.getClientRects()[0] || rect;
      }
      if (!rect) rect = (n.nodeType === 1 ? n : n.parentElement)?.getClientRects()[0];
    }
    return rect || null;
  }

  locate(range) {
    const rect = this.rectOf(range);
    if (!rect) return null;
    return this.scroll ? { top: rect.top } : { page: Math.floor((rect.left + 2) / this.g.W) };
  }

  place(at) {
    if (this.scroll) {
      this.clip.scrollTop = this.sheet.offsetTop + at.top - this.g.top;
      this.moved();
    } else {
      this.showPage(at.page);
    }
  }

  placeFragment(frag) {
    const d = this.doc;
    let target = null;
    try { target = d.getElementById(frag) || d.getElementsByName(frag)[0] || null; } catch { target = null; }
    if (!target) return false;
    const rect = target.getClientRects()[0] || target.getBoundingClientRect();
    if (this.scroll) this.place({ top: rect.top });
    else this.place({ page: Math.floor((rect.left + 2) / this.g.W) });
    return true;
  }

  // ---------- position ----------
  maxScroll() { return Math.max(0, this.clip.scrollHeight - this.clip.clientHeight); }

  chapterFrac() {
    if (this.scroll) { const m = this.maxScroll(); return m ? clamp(this.clip.scrollTop / m, 0, 1) : 0; }
    return this.pages > 1 ? this.page / (this.pages - 1) : 0;
  }

  setFrac(frac) {
    frac = clamp(frac || 0, 0, 1);
    if (this.scroll) {
      this.clip.scrollTop = Math.round(frac * this.maxScroll());
      this.moved();
    } else {
      this.showPage(Math.round(frac * (this.pages - 1)));
    }
  }

  // How far through the whole book, 0..1 (chapters weighted by their length).
  overall() {
    const size = this.book.chapters[this.ch]?.size || 0;
    const inCh = this.scroll ? this.chapterFrac() : (this.page + 1) / this.pages;
    return clamp((this.cum[this.ch] + inCh * size) / this.total, 0, 1);
  }
  locateOverall(v) {
    const target = clamp(v, 0, 1) * this.total;
    let ch = 0;
    while (ch + 1 < this.cum.length && this.cum[ch + 1] <= target) ch++;
    const size = this.book.chapters[ch].size || 1;
    return { ch, frac: clamp((target - this.cum[ch]) / size, 0, 1) };
  }
  atEnd() {
    if (this.ch !== this.book.chapters.length - 1) return false;
    return this.scroll ? this.clip.scrollTop >= this.maxScroll() - 4 : this.page >= this.pages - 1;
  }

  showPage(p, animate = false) {
    this.page = clamp(p, 0, this.pages - 1);
    const f = this.frame.style;
    f.transition = animate ? 'transform .24s ease-out' : 'none';
    f.transform = `translate3d(${-this.page * this.g.W}px,0,0)`;
    this.moved();
  }

  moved() {
    this.updateBar();
    this.saveProgress();
  }

  chapterTitle(ch) {
    let best = null;
    for (const t of this.toc || []) {
      if (t.ch === ch) { best = t; break; }
      if (t.ch < ch) best = t;
    }
    return best ? best.title : this.comic.name;
  }

  updateBar() {
    if (!this.book) return;
    const all = this.overall();
    const pct = Math.round(all * 100);
    this.slider.value = Math.round(all * 1000);
    this.pctEl.textContent = `${pct}%`;
    const title = this.chapterTitle(this.ch);
    this.whereEl.textContent = title;
    const left = this.pages - 1 - this.page;
    this.pageEl.textContent = this.scroll ? '' : `${this.page + 1} / ${this.pages}`;
    this.statusLeft.textContent = title;
    this.statusRight.textContent = this.scroll ? '' : (left ? `${left} ${left === 1 ? 'page' : 'pages'} left in chapter` : `${pct}%`);
  }

  updateChapterButtons() {
    const n = this.book.chapters.length;
    this.prevChBtn.hidden = !this.scroll || this.ch <= 0;
    this.nextChBtn.hidden = !this.scroll;
    if (this.ch > 0) this.prevChBtn.textContent = `‹  ${this.chapterTitle(this.ch - 1)}`;
    this.nextChBtn.textContent = this.ch < n - 1 ? `Next: ${this.chapterTitle(this.ch + 1)}  ›` : 'The end';
    this.nextChBtn.disabled = this.ch >= n - 1;
  }

  saveProgress() {
    clearTimeout(this.saveTimer);
    const id = this.comic.id;
    const ch = this.ch;
    const chPos = this.chapterFrac();
    const pos = this.overall();
    const done = this.atEnd();
    this.saveTimer = setTimeout(async () => {
      const c = await db.get('comics', id);
      if (c) await db.put('comics', { ...c, lastPage: ch, chPos, pos: done ? 1 : pos, done: c.done || done });
    }, 400);
  }

  // ---------- turning pages ----------
  next() {
    this.turned();
    if (this.scroll) {
      if (this.clip.scrollTop >= this.maxScroll() - 4) { if (this.ch < this.book.chapters.length - 1) this.goTo(this.ch + 1, {}); return; }
      this.clip.scrollBy({ top: this.clip.clientHeight * 0.88, behavior: 'smooth' });
      return;
    }
    if (this.page < this.pages - 1) this.showPage(this.page + 1, true);
    else if (this.ch < this.book.chapters.length - 1) this.goTo(this.ch + 1, {});
    else this.showPage(this.page, true);
    this.setChrome(false);
  }
  prev() {
    this.turned();
    if (this.scroll) {
      if (this.clip.scrollTop <= 4) { if (this.ch > 0) this.goTo(this.ch - 1, { end: true }); return; }
      this.clip.scrollBy({ top: -this.clip.clientHeight * 0.88, behavior: 'smooth' });
      return;
    }
    if (this.page > 0) this.showPage(this.page - 1, true);
    else if (this.ch > 0) this.goTo(this.ch - 1, { end: true });
    else this.showPage(0, true);
    this.setChrome(false);
  }
  // The "Back" button after following a link goes away once you've read on a few pages.
  turned() {
    if (this.backTo && ++this.backTurns > 3) this.hideBack();
  }
  hideBack() { this.backTo = null; this.backBtn.hidden = true; }

  followLink(a) {
    const out = a.getAttribute('data-cb-out');
    if (out) {
      if (/^(https?|mailto):/i.test(out)) window.open(out, '_blank', 'noopener');
      return;
    }
    const target = a.getAttribute('data-cb-href');
    if (!target) return;
    const frag = fragOf(target);
    let ch = this.chapterOf(target.split('#')[0]);
    if (frag && this.book.ids?.has(frag)) ch = this.book.ids.get(frag);
    if (ch < 0) return;
    this.backTo = { ch: this.ch, frac: this.chapterFrac() };
    this.backTurns = 0;
    this.backBtn.hidden = false;
    this.goTo(ch, { frag });
  }

  // ---------- taps and swipes ----------
  local(e) {
    const r = this.touch.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this.panelOpen()) { this.closePanels(); this.gest = null; e.preventDefault(); return; }
    if (!this.scroll) { try { this.touch.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    const p = this.local(e);
    this.gest = { id: e.pointerId, x: p.x, y: p.y, t: performance.now(), moved: false };
  }
  move(e) {
    const g = this.gest;
    if (!g || g.id !== e.pointerId) return;
    const p = this.local(e);
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
    if (this.scroll || !g.moved || Math.abs(dx) < Math.abs(dy)) return;
    // The page follows the finger a little, so a swipe feels connected.
    const f = this.frame.style;
    f.transition = 'none';
    f.transform = `translate3d(${-this.page * this.g.W + dx * 0.9}px,0,0)`;
  }
  up(e) {
    const g = this.gest;
    if (!g || g.id !== e.pointerId) return;
    this.gest = null;
    const p = this.local(e);
    const dx = p.x - g.x;
    const dy = p.y - g.y;
    if (!g.moved && performance.now() - g.t < 450) { this.tap(p.x, p.y); return; }
    if (this.scroll) return;
    const W = this.g.W;
    if (Math.abs(dx) > Math.min(60, W * 0.1) && Math.abs(dx) > Math.abs(dy) * 1.1) {
      if (dx < 0) this.next(); else this.prev();
    } else {
      this.showPage(this.page, true);
    }
  }
  cancelGesture() {
    if (this.gest && !this.scroll) this.showPage(this.page, true);
    this.gest = null;
  }
  tap(x, y) {
    const d = this.doc;
    if (!d) return;
    // A link under the finger?
    const ix = this.scroll ? x : x + this.page * this.g.W;
    let hit = null;
    try { hit = d.elementFromPoint(ix, y); } catch { hit = null; }
    const link = hit?.closest?.('[data-cb-href], [data-cb-out]');
    if (link) { this.followLink(link); return; }
    if (!this.scroll && this.tapTurn !== false) {
      const W = this.g.W;
      if (x < W * 0.28) { this.prev(); return; }
      if (x > W * 0.72) { this.next(); return; }
    }
    this.setChrome(!this.chrome);
  }
  wheel(e) {
    if (this.scroll || !this.isOpen) return;
    e.preventDefault();
    const now = performance.now();
    if (this.lastWheel && now - this.lastWheel < 350) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 4) return;
    this.lastWheel = now;
    if (d > 0) this.next(); else this.prev();
  }
  key(e) {
    if (!this.isOpen || !this.book || !document.getElementById('sheet').hidden) return;
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    switch (e.key) {
      case 'Escape': if (this.panelOpen()) this.closePanels(); else this.onClose(); break;
      case 'ArrowRight': case 'PageDown': this.next(); break;
      case 'ArrowLeft': case 'PageUp': this.prev(); break;
      case ' ': if (e.shiftKey) this.prev(); else this.next(); break;
      case 'ArrowDown': if (this.scroll) this.clip.scrollBy({ top: 60 }); else this.next(); break;
      case 'ArrowUp': if (this.scroll) this.clip.scrollBy({ top: -60 }); else this.prev(); break;
      case '+': case '=': this.setPref('size', clamp(bookPrefs.get('size') + SIZE_STEP, SIZE_MIN, SIZE_MAX)); break;
      case '-': this.setPref('size', clamp(bookPrefs.get('size') - SIZE_STEP, SIZE_MIN, SIZE_MAX)); break;
      default: return;
    }
    e.preventDefault();
  }

  // ---------- look ----------
  setChrome(visible) {
    this.chrome = visible;
    this.root.classList.toggle('chrome-hidden', !visible);
    if (!visible) this.closePanels();
  }
  showLoading(on) {
    this.loadingEl.hidden = !on;
    this.frame.style.visibility = on ? 'hidden' : '';
  }
  applyColors() {
    const t = THEMES[bookPrefs.theme()];
    const s = this.root.style;
    s.setProperty('--bk-bg', t.bg);
    s.setProperty('--bk-fg', t.fg);
    s.setProperty('--bk-muted', t.muted);
  }
  setPref(name, value) {
    bookPrefs.set(name, value);
    this.applyColors();
    this.relayout();
    if (!this.panel.hidden) this.drawPanel();
  }

  // ---------- panels: text settings (Aa) and contents ----------
  panelOpen() { return !this.panel.hidden || !this.tocPanel.hidden; }
  closePanels() {
    this.panel.hidden = true;
    this.tocPanel.hidden = true;
    this.aaBtn.setAttribute('aria-expanded', 'false');
    this.tocBtn.setAttribute('aria-expanded', 'false');
  }
  togglePanel(which) {
    const target = which === 'aa' ? this.panel : this.tocPanel;
    const wasOpen = !target.hidden;
    this.closePanels();
    if (wasOpen) return;
    if (which === 'aa') this.drawPanel(); else this.drawToc();
    target.hidden = false;
    (which === 'aa' ? this.aaBtn : this.tocBtn).setAttribute('aria-expanded', 'true');
    target.querySelector('[aria-checked="true"], button')?.focus();
  }

  drawPanel() {
    const p = bookPrefs.all();
    const theme = bookPrefs.theme();
    const seg = (label, key, options, value, styleOf) => {
      const wrap = el('div', { class: 'bk-seg', role: 'radiogroup', 'aria-label': label });
      for (const [val, text] of options) {
        wrap.append(el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(val === value),
          style: styleOf ? styleOf(val) : null,
          onclick: () => this.setPref(key, val),
        }, text));
      }
      return wrap;
    };
    const row = (label, control) => el('div', { class: 'bk-row' }, el('span', { class: 'bk-label' }, label), control);
    const size = el('div', { class: 'bk-size' },
      el('button', { type: 'button', class: 'bk-step small', 'aria-label': 'Smaller text', disabled: p.size <= SIZE_MIN ? '' : false,
        onclick: () => this.setPref('size', clamp(p.size - SIZE_STEP, SIZE_MIN, SIZE_MAX)) }, 'A'),
      el('span', { class: 'bk-size-val', 'aria-live': 'polite' }, `${p.size}%`),
      el('button', { type: 'button', class: 'bk-step big', 'aria-label': 'Bigger text', disabled: p.size >= SIZE_MAX ? '' : false,
        onclick: () => this.setPref('size', clamp(p.size + SIZE_STEP, SIZE_MIN, SIZE_MAX)) }, 'A'));
    const swatches = el('div', { class: 'bk-swatches', role: 'radiogroup', 'aria-label': 'Page color' },
      Object.entries(THEMES).map(([id, t]) => el('button', {
        type: 'button', role: 'radio', 'aria-checked': String(id === theme), 'aria-label': t.label, title: t.label,
        style: `--sw-bg:${t.bg};--sw-fg:${t.fg}`, onclick: () => this.setPref('theme', id),
      }, el('span', { 'aria-hidden': 'true' }, 'Aa'))));
    const wide = this.stage.clientWidth >= 800;

    this.panel.replaceChildren(
      el('div', { class: 'bk-head' }, el('h2', {}, 'Text'),
        el('button', { type: 'button', class: 'bk-close', 'aria-label': 'Close', onclick: () => this.closePanels() }, '×')),
      row('Size', size),
      row('Font', seg('Font', 'font', Object.entries(FONTS).map(([k, f]) => [k, f.label]), p.font,
        (k) => (FONTS[k].stack ? `font-family:${FONTS[k].stack}` : ''))),
      row('Line spacing', seg('Line spacing', 'spacing', [['tight', 'Tight'], ['normal', 'Normal'], ['loose', 'Loose']], p.spacing)),
      row('Margins', seg('Margins', 'margins', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']], p.margins)),
      row('Alignment', seg('Alignment', 'align', [['original', 'Book'], ['left', 'Left'], ['justify', 'Justified']], p.align)),
      row('Page color', swatches),
      row('Layout', seg('Layout', 'layout', [['pages', 'Pages'], ['scroll', 'Scroll']], p.layout)),
      wide && !this.scroll && row('Two columns', seg('Two columns', 'columns', [[true, 'On'], [false, 'Off']], p.columns)),
      el('button', { type: 'button', class: 'bk-reset', onclick: () => {
        for (const k of Object.keys(BOOK_DEFAULTS)) if (k !== 'theme') bookPrefs.set(k, BOOK_DEFAULTS[k]);
        this.setPref('theme', BOOK_DEFAULTS.theme);
      } }, 'Reset text settings'),
    );
  }

  drawToc() {
    const list = el('ol', { class: 'bk-toc-list' });
    const entries = this.toc.length
      ? this.toc
      : this.book.chapters.map((c, i) => ({ title: `Part ${i + 1}`, href: c.href, depth: 0, ch: i }));
    let current = null;
    for (const t of entries) if (t.ch <= this.ch) current = t;
    for (const t of entries) {
      list.append(el('li', {}, el('button', {
        type: 'button', class: t === current ? 'current' : '', 'aria-current': t === current ? 'true' : false,
        style: `padding-left:${16 + Math.min(t.depth, 4) * 18}px`,
        onclick: () => { this.closePanels(); this.hideBack(); this.goTo(t.ch, { frag: fragOf(t.href) }); },
      }, t.title)));
    }
    this.tocPanel.replaceChildren(
      el('div', { class: 'bk-head' }, el('h2', {}, 'Contents'),
        el('button', { type: 'button', class: 'bk-close', 'aria-label': 'Close', onclick: () => this.closePanels() }, '×')),
      list);
    setTimeout(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }), 0);
  }

  // Keeps the screen from dimming while reading (where the browser allows it).
  async keepAwake(on) {
    this.wantAwake = on;
    if (!on) { try { await this.wakeLock?.release(); } catch { /* already released */ } this.wakeLock = null; return; }
    if (!('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { this.wakeLock = null; }
    if (!this.wakeListener) {
      this.wakeListener = () => { if (document.visibilityState === 'visible' && this.isOpen && this.wantAwake) this.keepAwake(true); };
      document.addEventListener('visibilitychange', this.wakeListener);
    }
  }
}
