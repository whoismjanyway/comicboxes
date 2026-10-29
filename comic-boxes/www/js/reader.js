import * as db from './db.js';
import { openBook } from './comic.js';

const MAX_ZOOM = 6;
const DOUBLE_TAP_ZOOM = 2.5;
const prefs = {
  get(k, d) { try { const v = localStorage.getItem('cb.' + k); return v == null ? d : v === '1'; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cb.' + k, v ? '1' : '0'); } catch { /* private mode */ } },
};

export class Reader {
  constructor({ onClose }) {
    this.onClose = onClose;
    this.root = document.getElementById('reader');
    this.stage = document.getElementById('stage');
    this.pagesEl = document.getElementById('pages');
    this.slider = document.getElementById('pageSlider');
    this.pageNum = document.getElementById('pageNum');
    this.titleEl = document.getElementById('readerTitle');
    this.spreadBtn = document.getElementById('spreadBtn');
    this.dirBtn = document.getElementById('dirBtn');

    this.isOpen = false;
    this.urls = new Map();
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.pointers = new Map();
    this.spread = prefs.get('spread', true);
    this.rtl = prefs.get('rtl', false);

    document.getElementById('closeReader').addEventListener('click', () => this.onClose());
    this.spreadBtn.addEventListener('click', () => { this.spread = !this.spread; prefs.set('spread', this.spread); this.syncButtons(); this.show(this.page); });
    this.dirBtn.addEventListener('click', () => { this.rtl = !this.rtl; prefs.set('rtl', this.rtl); this.syncButtons(); this.show(this.page); });
    this.slider.addEventListener('input', () => { this.pageNum.textContent = `${this.slider.value} / ${this.count}`; });
    this.slider.addEventListener('change', () => this.show(this.viewStart(+this.slider.value - 1)));

    this.stage.addEventListener('pointerdown', (e) => this.down(e));
    this.stage.addEventListener('pointermove', (e) => this.move(e));
    this.stage.addEventListener('pointerup', (e) => this.up(e));
    this.stage.addEventListener('pointercancel', (e) => this.up(e));
    this.stage.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.key(e));
    window.addEventListener('resize', () => { if (this.isOpen) this.show(this.viewStart(this.page)); });
  }

  // ---------- open / close ----------
  async open(comic) {
    if (this.isOpen && this.comic && this.comic.id === comic.id) return;
    if (this.isOpen) this.close();
    this.releaseUrls();
    this.comic = comic;
    this.isOpen = true;
    this.root.hidden = false;
    this.titleEl.textContent = comic.name;
    this.pagesEl.replaceChildren(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'Opening…' }));
    this.setChrome(true);
    this.syncButtons();

    const file = await db.get('files', comic.id);
    if (!file) throw new Error('file missing');
    const book = await openBook(file.blob, comic.format || 'cbz');
    if (!this.isOpen || this.comic !== comic) { book.close(); return; }
    this.archive = book;
    if (!book.count) throw new Error('no pages');
    this.count = this.archive.count;
    this.slider.max = this.count;
    const start = comic.done ? 0 : Math.min(comic.lastPage || 0, this.count - 1);
    await this.show(this.viewStart(start));
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    clearTimeout(this.tapTimer);
    this.releaseUrls();
    try { this.archive?.close(); } catch { /* already closed */ }
    this.archive = null;
  }

  releaseUrls() {
    for (const u of this.urls.values()) u.then((x) => URL.revokeObjectURL(x)).catch(() => {});
    this.urls.clear();
  }

  // ---------- pages and spreads ----------
  spreadActive() {
    return this.spread && window.innerWidth > window.innerHeight && window.innerWidth >= 700;
  }
  // In two-page view the cover sits alone, then pages pair up: [1] [2 3] [4 5] ...
  viewStart(p) {
    if (!this.spreadActive() || p <= 0) return Math.max(0, p);
    return p - ((p - 1) % 2);
  }
  viewPages(start) {
    if (!this.spreadActive() || start === 0) return [start];
    return [start, start + 1].filter((i) => i < this.count);
  }

  url(i) {
    if (!this.urls.has(i)) {
      this.urls.set(i, this.archive.page(i).then((b) => URL.createObjectURL(b)));
    }
    return this.urls.get(i);
  }
  trimCache(keep) {
    for (const [i, u] of this.urls) {
      if (Math.abs(i - keep) > 6) { u.then((x) => URL.revokeObjectURL(x)); this.urls.delete(i); }
    }
  }

  async show(start) {
    if (!this.archive) return;
    start = Math.max(0, Math.min(start, this.count - 1));
    const token = (this.token = Symbol('view'));
    this.page = start;
    const idx = this.viewPages(start);
    this.updateBar(idx);

    const srcs = await Promise.all(idx.map((i) => this.url(i)));
    if (token !== this.token || !this.isOpen) return;

    const imgs = srcs.map((src, n) => {
      const img = new Image();
      img.src = src;
      img.alt = `Page ${idx[n] + 1}`;
      img.draggable = false;
      return img;
    });
    await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
    if (token !== this.token) return;

    this.pagesEl.classList.toggle('spread', idx.length > 1);
    this.pagesEl.classList.toggle('rtl', this.rtl);
    this.pagesEl.replaceChildren(...imgs);
    this.resetZoom(false);

    // Warm up the next pages so turning feels instant.
    const after = start + idx.length;
    for (let i = after; i < Math.min(after + 3, this.count); i++) this.url(i);
    if (start > 0) this.url(start - 1);
    this.trimCache(start);
    this.saveProgress(idx[idx.length - 1]);
  }

  next() {
    const n = this.page + this.viewPages(this.page).length;
    if (n < this.count) { this.show(n); this.setChrome(false); }
  }
  prev() {
    if (this.page > 0) { this.show(this.viewStart(this.page - 1)); this.setChrome(false); }
  }
  forward() { this.rtl ? this.prev() : this.next(); }
  backward() { this.rtl ? this.next() : this.prev(); }

  updateBar(idx) {
    const label = idx.length > 1 ? `${idx[0] + 1}–${idx[1] + 1}` : `${idx[0] + 1}`;
    this.pageNum.textContent = `${label} / ${this.count}`;
    this.slider.value = idx[0] + 1;
    this.slider.style.direction = this.rtl ? 'rtl' : 'ltr';
  }

  syncButtons() {
    this.spreadBtn.setAttribute('aria-pressed', String(this.spread));
    this.dirBtn.setAttribute('aria-pressed', String(this.rtl));
    this.spreadBtn.hidden = !(window.innerWidth >= 700);
  }

  saveProgress(lastShown) {
    clearTimeout(this.saveTimer);
    const id = this.comic.id;
    const done = lastShown >= this.count - 1;
    const page = this.page;
    this.saveTimer = setTimeout(async () => {
      const c = await db.get('comics', id);
      if (c) await db.put('comics', { ...c, lastPage: done ? 0 : page, done: c.done || done });
    }, 300);
  }

  setChrome(visible) {
    this.chrome = visible;
    this.root.classList.toggle('chrome-hidden', !visible);
  }

  // ---------- zoom and pan ----------
  bounds() {
    // Area covered by the page images, before zoom, in stage coordinates.
    const imgs = [...this.pagesEl.querySelectorAll('img')];
    if (!imgs.length) return { x0: 0, y0: 0, x1: this.stage.clientWidth, y1: this.stage.clientHeight };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const im of imgs) {
      x0 = Math.min(x0, im.offsetLeft); y0 = Math.min(y0, im.offsetTop);
      x1 = Math.max(x1, im.offsetLeft + im.offsetWidth); y1 = Math.max(y1, im.offsetTop + im.offsetHeight);
    }
    return { x0, y0, x1, y1 };
  }
  clamp() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight, s = this.scale;
    const b = this.bounds();
    const fit = (t, lo, hi, size, view) => {
      if ((hi - lo) * s <= view) return (view - (lo + hi) * s) / 2; // smaller than screen: center it
      return Math.min(-lo * s, Math.max(view - hi * s, t));
    };
    this.tx = fit(this.tx, b.x0, b.x1, W, W);
    this.ty = fit(this.ty, b.y0, b.y1, H, H);
  }
  apply(animate = false) {
    this.pagesEl.classList.toggle('animate', animate);
    this.pagesEl.style.transform = `translate3d(${this.tx}px, ${this.ty}px, 0) scale(${this.scale})`;
  }
  resetZoom(animate = true) {
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.apply(animate);
  }
  zoomAt(px, py, newScale, animate = false) {
    newScale = Math.min(MAX_ZOOM, Math.max(1, newScale));
    const cx = (px - this.tx) / this.scale, cy = (py - this.ty) / this.scale;
    this.scale = newScale;
    this.tx = px - cx * newScale; this.ty = py - cy * newScale;
    if (newScale === 1) { this.tx = 0; this.ty = 0; } else this.clamp();
    this.apply(animate);
  }
  local(e) {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------- gestures ----------
  down(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer */ }
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 1) {
      const p = this.local(e);
      this.g = { sx: p.x, sy: p.y, stx: this.tx, sty: this.ty, t: performance.now(), moved: false, multi: false };
    } else if (this.pointers.size === 2) {
      this.startPinch();
    }
  }
  startPinch() {
    const [a, b] = [...this.pointers.values()];
    this.g.multi = true;
    this.g.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      scale: this.scale,
      cx: ((a.x + b.x) / 2 - this.tx) / this.scale,
      cy: ((a.y + b.y) / 2 - this.ty) / this.scale,
    };
  }
  move(e) {
    if (!this.pointers.has(e.pointerId) || !this.g) return;
    this.pointers.set(e.pointerId, this.local(e));
    const g = this.g;

    if (this.pointers.size >= 2 && g.pinch) {
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.scale = Math.min(MAX_ZOOM, Math.max(0.8, g.pinch.scale * (dist / g.pinch.dist)));
      this.tx = mx - g.pinch.cx * this.scale;
      this.ty = my - g.pinch.cy * this.scale;
      if (this.scale >= 1) this.clamp();
      this.apply();
      return;
    }

    const p = this.pointers.get(e.pointerId);
    const dx = p.x - g.sx, dy = p.y - g.sy;
    if (!g.moved && Math.hypot(dx, dy) > 8) g.moved = true;
    if (!g.moved || g.multi) return;

    if (this.scale > 1.01) {
      this.tx = g.stx + dx; this.ty = g.sty + dy;
      this.clamp();
      this.apply();
    } else if (Math.abs(dx) > Math.abs(dy)) {
      // drag the page a little so a swipe feels connected to the finger
      this.tx = dx * 0.6;
      this.apply();
    }
  }
  up(e) {
    if (!this.pointers.has(e.pointerId)) return;
    const last = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const g = this.g;
    if (!g) return;

    if (this.pointers.size === 1) {
      // one finger lifted after a pinch: keep panning with the other
      const p = [...this.pointers.values()][0];
      Object.assign(g, { sx: p.x, sy: p.y, stx: this.tx, sty: this.ty, moved: true, pinch: null });
      return;
    }
    if (this.pointers.size > 1) { this.startPinch(); return; }

    this.g = null;
    if (g.multi) {
      if (this.scale < 1.05) this.resetZoom(true);
      return;
    }
    const dx = last.x - g.sx, dy = last.y - g.sy;
    if (!g.moved && performance.now() - g.t < 350) { this.tap(last.x, last.y); return; }

    if (this.scale <= 1.01) {
      const W = this.stage.clientWidth;
      if (Math.abs(dx) > Math.min(70, W * 0.12) && Math.abs(dx) > Math.abs(dy) * 1.2) {
        // swipe left = next page (in manga mode it's the other way round)
        this.resetZoom(true);
        if (dx < 0) this.forward(); else this.backward();
      } else {
        this.resetZoom(true);
      }
    }
  }
  tap(x, y) {
    const now = performance.now();
    if (this.lastTap && now - this.lastTap.t < 300 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      if (this.scale > 1.05) this.resetZoom(true);
      else this.zoomAt(x, y, DOUBLE_TAP_ZOOM, true);
      return;
    }
    this.lastTap = { t: now, x, y };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => {
      const W = this.stage.clientWidth;
      if (this.scale > 1.05) { this.setChrome(!this.chrome); return; }
      if (x < W * 0.28) this.backward();
      else if (x > W * 0.72) this.forward();
      else this.setChrome(!this.chrome);
    }, 260);
  }
  wheel(e) {
    if (!this.isOpen) return;
    e.preventDefault();
    const p = this.local(e);
    if (e.ctrlKey || this.scale <= 1.01) {
      // trackpad pinch arrives as ctrl+wheel; a plain wheel zooms when not zoomed in yet
      this.zoomAt(p.x, p.y, this.scale * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
    } else {
      this.tx -= e.deltaX; this.ty -= e.deltaY;
      this.clamp(); this.apply();
    }
  }
  key(e) {
    if (!this.isOpen || !document.getElementById('sheet').hidden) return;
    const W = this.stage.clientWidth / 2, H = this.stage.clientHeight / 2;
    switch (e.key) {
      case 'ArrowRight': this.rtl ? this.prev() : this.next(); break;
      case 'ArrowLeft': this.rtl ? this.next() : this.prev(); break;
      case ' ': case 'PageDown': this.next(); break;
      case 'PageUp': this.prev(); break;
      case '+': case '=': this.zoomAt(W, H, this.scale * 1.4, true); break;
      case '-': this.zoomAt(W, H, this.scale / 1.4, true); break;
      case '0': this.resetZoom(true); break;
      case 'Escape': this.onClose(); break;
      default: return;
    }
    e.preventDefault();
  }
}
