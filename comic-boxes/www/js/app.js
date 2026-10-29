import * as db from './db.js';
import { ROOT } from './db.js';
import { naturalCompare } from './comic.js';
import { entriesFromFiles, entriesFromDrop, plan, run } from './importer.js';
import { Reader } from './reader.js';
import * as settings from './settings.js';
import { SECTIONS } from './settings.js';

const $ = (id) => document.getElementById(id);
const shelf = $('shelf');
const fileInput = $('fileInput');
const folderInput = $('folderInput');

let currentBox = ROOT;
let busy = false;
const coverUrls = new Map();

// ---------- helpers ----------
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
const svg = (d) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = d;
  return s;
};
const ICON = {
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14l3 3 3-3"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10v6M9 13l3 3 3-3"/>',
  box: '<path d="M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM2 5h20v4H2zM10 13h4"/>',
};
// Comics added by the first version stored `colors` instead of `color`.
const tint = (c) => c.color || (c.colors && c.colors[0]) || '';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function coverUrl(comic) {
  if (!comic.cover) return null;
  if (!coverUrls.has(comic.id)) coverUrls.set(comic.id, URL.createObjectURL(comic.cover));
  return coverUrls.get(comic.id);
}
function forgetCover(id) {
  if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
}

// ---------- theme ----------
const themeSwitch = $('themeSwitch');
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  themeSwitch.setAttribute('aria-checked', String(t === 'dark'));
  document.querySelector('meta[name=theme-color]').setAttribute('content', t === 'dark' ? '#000000' : '#ffffff');
}
themeSwitch.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  settings.setTheme(next);
  applyTheme(next);
});
applyTheme(settings.resolvedTheme());
// "Match device": follow the phone's light/dark setting live.
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (settings.getTheme() === 'auto') applyTheme(settings.resolvedTheme());
});
const applyCoverSize = () => { document.documentElement.dataset.size = settings.get('coverSize'); };
applyCoverSize();

// ---------- routing ----------
let openedFromLibrary = false;
const reader = new Reader({
  onClose: () => {
    if (openedFromLibrary) { openedFromLibrary = false; history.back(); } else goBox(currentBox);
  },
});

function route() {
  if (location.hash === '#/settings') {
    reader.close();
    renderSettings();
    return;
  }
  const [, kind, id] = location.hash.match(/^#\/(box|read)\/(.+)$/) || [];
  if (kind === 'read') {
    openReader(decodeURIComponent(id));
  } else {
    reader.close();
    currentBox = kind === 'box' ? decodeURIComponent(id) : ROOT;
    render();
  }
}
window.addEventListener('hashchange', route);

const goBox = (id) => { location.hash = id === ROOT ? '#/' : `#/box/${encodeURIComponent(id)}`; };
const goRead = (id) => { openedFromLibrary = true; location.hash = `#/read/${encodeURIComponent(id)}`; };

async function openReader(id) {
  const comic = await db.get('comics', id);
  if (!comic) { goBox(ROOT); return; }
  currentBox = comic.boxId;
  await db.put('comics', { ...comic, opened: Date.now() });
  $('library').setAttribute('aria-hidden', 'true');
  try {
    await reader.open(comic);
  } catch (e) {
    console.error(e);
    toast(`Couldn't open ${comic.name}. The file may be damaged.`);
    reader.close();
    goBox(comic.boxId);
  }
}

// ---------- library ----------
async function render() {
  $('library').removeAttribute('aria-hidden');
  const [boxes, comics] = await Promise.all([db.all('boxes'), db.all('comics')]);
  const lib = indexLibrary(boxes, comics);
  if (currentBox !== ROOT && !lib.box.has(currentBox)) { goBox(ROOT); return; }

  renderHeader(lib);

  const childBoxes = lib.kids(currentBox);
  const childComics = lib.issues(currentBox);
  shelf.replaceChildren();

  if (!childBoxes.length && !childComics.length) {
    shelf.append(emptyState(currentBox === ROOT));
    return;
  }

  const isRoot = currentBox === ROOT;
  const builders = {
    boxes: () => childBoxes.length && section('Boxes', childBoxes.length,
      el('div', { class: 'grid boxes' }, childBoxes.map((b) => boxCard(b, lib)))),
    issues: () => childComics.length && section(isRoot ? 'Not in a box' : 'Issues', childComics.length,
      el('div', { class: 'grid issues' }, childComics.map((c) => issueCard(c)))),
    reading: () => {
      const reading = comics.filter((c) => c.lastPage > 0 && !c.done)
        .sort((a, b) => (b.opened || 0) - (a.opened || 0)).slice(0, settings.get('readingCount'));
      return reading.length && section('Keep reading', null,
        el('div', { class: 'strip' }, reading.map((c) => issueCard(c, lib.box.get(c.boxId)?.name || 'Not in a box'))));
    },
  };
  builders.loose = builders.issues;
  const order = isRoot
    ? settings.get('homeOrder').filter((id) => !settings.get('homeHidden').includes(id))
    : settings.get('boxOrder');
  for (const id of order) {
    const node = builders[id]();
    if (node) shelf.append(node);
  }
}

function indexLibrary(boxes, comics) {
  const box = new Map(boxes.map((b) => [b.id, b]));
  const kidsOf = new Map();
  const issuesOf = new Map();
  for (const b of boxes) (kidsOf.get(b.parentId) || kidsOf.set(b.parentId, []).get(b.parentId)).push(b);
  for (const c of comics) (issuesOf.get(c.boxId) || issuesOf.set(c.boxId, []).get(c.boxId)).push(c);
  const byName = (a, b) => naturalCompare(a.name, b.name);
  const boxSort = settings.get('boxSort') === 'added' ? (a, b) => (b.created || 0) - (a.created || 0) || byName(a, b) : byName;
  const issueSort = {
    name: byName,
    added: (a, b) => (b.added || 0) - (a.added || 0) || byName(a, b),
    opened: (a, b) => (b.opened || 0) - (a.opened || 0) || byName(a, b),
  }[settings.get('issueSort')] || byName;
  for (const l of kidsOf.values()) l.sort(boxSort);
  for (const l of issuesOf.values()) l.sort(issueSort);
  const kids = (id) => kidsOf.get(id) || [];
  const issues = (id) => issuesOf.get(id) || [];
  const total = new Map();
  const countAll = (id) => {
    if (!total.has(id)) total.set(id, issues(id).length + kids(id).reduce((s, k) => s + countAll(k.id), 0));
    return total.get(id);
  };
  // First few covers found in a box, looking in smaller boxes if it has no issues of its own.
  const covers = (id, n = 3) => {
    const out = [];
    const queue = [id];
    while (queue.length && out.length < n) {
      const b = queue.shift();
      for (const c of issues(b)) { if (out.length < n) out.push(c); }
      queue.push(...kids(b).map((k) => k.id));
    }
    return out;
  };
  return { box, kids, issues, countAll, covers };
}

function renderHeader(lib) {
  const trail = [];
  let id = currentBox;
  while (id !== ROOT && lib.box.has(id)) { trail.unshift(lib.box.get(id)); id = lib.box.get(id).parentId; }

  setTopbarMode('library');
  const here = trail.length ? trail[trail.length - 1].name : 'My boxes';
  $('title').textContent = here;
  document.title = trail.length ? here : 'Comic Boxes';
  $('upBtn').hidden = !trail.length;

  const path = $('path');
  path.replaceChildren();
  if (trail.length) {
    const above = [{ id: ROOT, name: 'My boxes' }, ...trail.slice(0, -1)];
    above.forEach((b, i) => {
      if (i) path.append(el('span', { class: 'sep', 'aria-hidden': 'true' }, '/'));
      path.append(el('button', { type: 'button', onclick: () => goBox(b.id) }, b.name));
    });
  }
}
$('upBtn').addEventListener('click', async () => {
  if (location.hash === '#/settings') { goBox(currentBox); return; }
  const b = await db.get('boxes', currentBox);
  goBox(b ? b.parentId : ROOT);
});
$('settingsBtn').addEventListener('click', () => { location.hash = '#/settings'; });

function setTopbarMode(mode) {
  const inSettings = mode === 'settings';
  $('settingsBtn').hidden = inSettings;
  $('themeSwitch').hidden = inSettings;
  $('addBtn').hidden = inSettings;
  document.body.classList.toggle('in-settings', inSettings);
}

function section(title, count, body) {
  return el('section', { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', {}, title), count != null && el('span', { class: 'count' }, String(count))),
    body);
}

// The long box: divider cards for the boxes inside it, covers of the issues inside it, a tape label.
const PEEK = {
  1: [{ x: 35, y: 0, r: 2 }],
  2: [{ x: 19, y: 1, r: -4 }, { x: 50, y: -2, r: 3 }],
  3: [{ x: 7, y: 1, r: -6 }, { x: 35, y: -3, r: 1 }, { x: 63, y: 1, r: 6 }],
};
function boxArt(name, dividers = [], covers = []) {
  const spots = PEEK[covers.length] || [];
  return el('div', { class: 'box-art', 'aria-hidden': 'true' },
    el('div', { class: 'box-back' }),
    dividers.map((d, i) => el('div', { class: 'divider', style: `--i:${i};--tab-x:${i ? 46 : 4}cqw` },
      el('span', { class: 'tab' }, d))),
    covers.map((c, i) => el('div', {
      class: 'peek', style: `--x:${spots[i].x}cqw;--y:${spots[i].y}cqw;--r:${spots[i].r}deg;--c:${tint(c)}`,
    }, coverUrl(c) && el('img', { src: coverUrl(c), alt: '', loading: 'lazy', decoding: 'async' }))),
    el('div', { class: 'box-front' },
      el('span', { class: `tape${name.length > 13 ? ' long' : ''}` }, name),
      el('span', { class: 'hand' })));
}

function boxCard(box, lib) {
  const subs = lib.kids(box.id);
  const total = lib.countAll(box.id);
  const parts = [];
  if (subs.length) parts.push(plural(subs.length, 'box', 'boxes'));
  parts.push(total ? plural(total, 'issue', 'issues') : 'Empty');
  return el('div', { class: 'card box-card' },
    el('button', { class: 'box', type: 'button', 'aria-label': `${box.name}, ${parts.join(', ')}`,
      onclick: () => goBox(box.id), oncontextmenu: (e) => { e.preventDefault(); boxMenu(box); } },
    boxArt(box.name, subs.slice(0, 2).map((s) => s.name), lib.covers(box.id)),
    el('div', { class: 'box-meta' }, parts.join(', '))),
    el('button', { class: 'more', type: 'button', 'aria-label': `Options for ${box.name}`, onclick: () => boxMenu(box) }, svg(ICON.more)));
}

function issueCard(c, where) {
  let sticker;
  if (c.done) sticker = el('span', { class: 'sticker read' }, 'READ');
  else if (!c.lastPage) sticker = el('span', { class: 'sticker new' }, 'NEW');
  else sticker = el('span', { class: 'sticker' }, `${c.lastPage + 1}/${c.pages}`);
  const pct = !c.done && c.lastPage ? Math.round(((c.lastPage + 1) / c.pages) * 100) : 0;
  const meta = where || [plural(c.pages || 0, 'page', 'pages'), c.source && !['CBZ', 'Images'].includes(c.source) ? c.source : null].filter(Boolean).join(', ');

  return el('div', { class: 'card issue-card' },
    el('button', { class: 'issue', type: 'button', onclick: () => goRead(c.id), oncontextmenu: (e) => { e.preventDefault(); comicMenu(c); } },
      el('span', { class: 'issue-art' },
        el('span', { class: 'hook' }),
        el('span', { class: 'bag' },
          el('span', { class: 'cover', style: `--c:${tint(c)}` },
            coverUrl(c) && el('img', { src: coverUrl(c), alt: '', loading: 'lazy', decoding: 'async' })),
          sticker,
          pct ? el('span', { class: 'read-bar' }, el('i', { style: `width:${pct}%` })) : null)),
      el('span', { class: 'issue-title' }, c.name),
      el('span', { class: 'issue-meta' }, meta)),
    el('button', { class: 'more', type: 'button', 'aria-label': `Options for ${c.name}`, onclick: () => comicMenu(c) }, svg(ICON.more)));
}

function emptyState(isRoot) {
  return el('div', { class: 'empty' },
    boxArt(isRoot ? 'Comics' : $('title').textContent),
    el('h2', {}, isRoot ? 'Fill your first box' : 'This box is empty'),
    el('p', {}, isRoot
      ? 'Add a folder of comics and its subfolders become boxes inside boxes. Or add single comic files.'
      : 'Add comics or a folder here. Folders inside it become smaller boxes.'),
    el('div', { class: 'btns' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => folderInput.click() }, svg(ICON.folder), 'Add a folder'),
      el('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, svg(ICON.file), 'Add comic files'),
      el('button', { class: 'btn', type: 'button', onclick: newBox }, svg(ICON.box), 'New empty box')));
}

// ---------- sheet: menus and dialogs ----------
const sheet = $('sheet');
const scrim = $('scrim');
let lastFocus = null;
let sheetCancel = null;
function openSheet(content, onCancel = null) {
  lastFocus = document.activeElement;
  sheetCancel = onCancel;
  sheet.replaceChildren(...content);
  sheet.hidden = false;
  scrim.hidden = false;
  sheet.querySelector('input, button')?.focus();
}
function closeSheet() {
  sheet.hidden = true;
  scrim.hidden = true;
  sheetCancel = null;
  lastFocus?.focus?.();
}
function cancelSheet() {
  const fn = sheetCancel;
  closeSheet();
  fn?.();
}
scrim.addEventListener('click', cancelSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) cancelSheet(); });

const menuBtn = (label, fn, cls = '') =>
  el('button', { class: `menu-btn ${cls}`, type: 'button', onclick: () => { closeSheet(); fn(); } }, label);
const bigMenuBtn = (icon, title, desc, fn, red = false) =>
  el('button', { class: 'menu-btn', type: 'button', onclick: () => { closeSheet(); fn(); } },
    el('span', { class: `tile${red ? ' red' : ''}` }, svg(icon)),
    el('span', {}, el('b', {}, title), el('small', {}, desc)));

function askText(title, value, okLabel) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', value, enterkeyhint: 'done', autocomplete: 'off', 'aria-label': title });
    const done = (v) => { closeSheet(); resolve(v); };
    openSheet([el('form', { onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); if (v) done(v); } },
      el('h3', {}, title), input,
      el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', onclick: () => done(null) }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'submit' }, okLabel)))], () => resolve(null));
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

function confirmSheet(title, text, okLabel) {
  return new Promise((resolve) => {
    const done = (v) => { closeSheet(); resolve(v); };
    openSheet([el('h3', {}, title), el('p', { style: 'margin:0;color:var(--muted)' }, text),
      el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => done(true) }, okLabel))], () => resolve(false));
  });
}

async function pickBox(title, exclude = new Set()) {
  const boxes = await db.all('boxes');
  const kids = (pid) => boxes.filter((b) => b.parentId === pid).sort((a, b) => naturalCompare(a.name, b.name));
  return new Promise((resolve) => {
    const list = el('ul', { class: 'tree' });
    const add = (id, name, depth) => list.append(el('li', {},
      el('button', { type: 'button', style: `padding-left:${8 + depth * 22}px`, onclick: () => { closeSheet(); resolve(id); } },
        el('span', { class: 'mini-box' }), name)));
    const walk = (pid, depth) => { for (const b of kids(pid)) { if (exclude.has(b.id)) continue; add(b.id, b.name, depth); walk(b.id, depth + 1); } };
    add(ROOT, 'My boxes (top level)', 0);
    walk(ROOT, 1);
    openSheet([el('h3', {}, title), list,
      el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); resolve(null); } }, 'Cancel'))],
    () => resolve(null));
  });
}

async function newBox() {
  const name = await askText('New box', '', 'Create box');
  if (!name) return;
  await db.put('boxes', { id: db.uid(), name, parentId: currentBox, created: Date.now() });
  render();
}

function addMenu() {
  const where = currentBox === ROOT ? 'My boxes' : $('title').textContent;
  openSheet([
    el('h3', {}, `Add to ${where}`),
    bigMenuBtn(ICON.folder, 'A folder', 'Every comic inside is added. Folders inside it become boxes inside this box.', () => folderInput.click(), true),
    bigMenuBtn(ICON.file, 'Comic files', 'CBZ, CBR, CB7, CBT, PDF or EPUB. Pick as many as you like.', () => fileInput.click()),
    bigMenuBtn(ICON.box, 'New empty box', 'Name it now and fill it later.', newBox),
    el('p', { class: 'hint' }, 'Phone can\'t pick folders? Zip the folder and add the .zip under Comic files. It turns into boxes the same way.'),
  ]);
}
$('addBtn').addEventListener('click', addMenu);

function boxMenu(box) {
  openSheet([el('h3', {}, box.name),
    menuBtn('Open', () => goBox(box.id)),
    menuBtn('Rename', async () => {
      const name = await askText('Rename box', box.name, 'Save');
      if (name) { await db.put('boxes', { ...box, name }); render(); }
    }),
    menuBtn('Move to another box', async () => {
      const target = await pickBox(`Move "${box.name}" into`, await db.descendantIds(box.id));
      if (target != null && target !== box.parentId) { await db.put('boxes', { ...box, parentId: target }); render(); toast('Box moved'); }
    }),
    menuBtn('Delete box', async () => {
      if (await confirmSheet(`Delete "${box.name}"?`, 'The box, every box inside it and all their comics are removed from this device.', 'Delete')) {
        await db.deleteBox(box.id); render(); toast('Box deleted');
      }
    }, 'danger')]);
}

function comicMenu(c) {
  const unread = c.done || c.lastPage;
  openSheet([el('h3', {}, c.name),
    menuBtn('Read', () => goRead(c.id)),
    menuBtn('Rename', async () => {
      const name = await askText('Rename comic', c.name, 'Save');
      if (name) { await db.put('comics', { ...c, name }); render(); }
    }),
    menuBtn('Move to another box', async () => {
      const target = await pickBox(`Move "${c.name}" into`);
      if (target != null && target !== c.boxId) { await db.put('comics', { ...c, boxId: target }); render(); toast('Comic moved'); }
    }),
    menuBtn(unread ? 'Mark as unread' : 'Mark as read', async () => {
      await db.put('comics', { ...c, done: !unread, lastPage: 0 }); render();
    }),
    menuBtn('Delete comic', async () => {
      if (await confirmSheet(`Delete "${c.name}"?`, 'The comic is removed from this device.', 'Delete')) {
        await db.deleteComic(c.id); forgetCover(c.id); render(); toast('Comic deleted');
      }
    }, 'danger')]);
}

// ---------- settings page ----------
const ICON_UP = '<path d="M6 15l6-6 6 6"/>';
const ICON_DOWN = '<path d="M6 9l6 6 6-6"/>';

function toggle(on, label, onChange, disabled = false) {
  const b = el('button', {
    class: 'toggle', type: 'button', role: 'switch', 'aria-checked': String(on), 'aria-label': label,
    disabled: disabled ? '' : false,
    onclick: () => { const v = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(v)); onChange(v); },
  }, el('span', { class: 'knob' }));
  return b;
}

function segmented(label, options, value, onChange) {
  const wrap = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  for (const [val, text] of options) {
    const b = el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(val === value),
      onclick: () => {
        wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
        onChange(val);
      },
    }, text);
    wrap.append(b);
  }
  return wrap;
}

const setRow = (title, desc, control, stack = false) =>
  el('div', { class: `set-row${stack ? ' stack' : ''}` },
    el('div', { class: 'set-text' }, el('b', {}, title), desc && el('small', {}, desc)),
    control);

const setGroup = (title, note, ...rows) =>
  el('section', { class: 'section set-section' },
    el('div', { class: 'section-head' }, el('h2', {}, title)),
    note && el('p', { class: 'set-note' }, note),
    el('div', { class: 'set-group' }, rows));

// A reorderable list of sections, with optional show/hide switches.
function orderList(key, defs, hiddenKey) {
  const list = el('div', { class: 'order-list' });
  const draw = (focusSel) => {
    const order = settings.get(key);
    const hidden = hiddenKey ? settings.get(hiddenKey) : [];
    list.replaceChildren(...order.map((id, i) => {
      const d = defs.find((x) => x.id === id);
      const isHidden = hidden.includes(id);
      const move = (dir) => {
        const o = [...order];
        [o[i], o[i + dir]] = [o[i + dir], o[i]];
        settings.set(key, o);
        draw(`[data-id="${id}"] .${dir < 0 ? 'up' : 'down'}`);
      };
      return el('div', { class: `set-row order-row${isHidden ? ' is-hidden' : ''}`, 'data-id': id },
        el('span', { class: 'pos', 'aria-hidden': 'true' }, String(i + 1)),
        el('div', { class: 'set-text' }, el('b', {}, d.label),
          hiddenKey && el('small', {}, isHidden ? 'Hidden' : d.canHide ? 'Shown' : 'Always shown')),
        el('div', { class: 'order-btns' },
          el('button', { class: 'mini up', type: 'button', 'aria-label': `Move ${d.label} up`, disabled: i === 0 ? '' : false, onclick: () => move(-1) }, svg(ICON_UP)),
          el('button', { class: 'mini down', type: 'button', 'aria-label': `Move ${d.label} down`, disabled: i === order.length - 1 ? '' : false, onclick: () => move(1) }, svg(ICON_DOWN))),
        hiddenKey && (d.canHide
          ? toggle(!isHidden, `Show ${d.label}`, (on) => {
            const h = new Set(settings.get(hiddenKey));
            if (on) h.delete(id); else h.add(id);
            settings.set(hiddenKey, [...h]);
            draw(`[data-id="${id}"] .toggle`);
          })
          : el('span', { class: 'toggle-spacer' })));
    }));
    if (focusSel) {
      const t = list.querySelector(focusSel);
      (t && !t.disabled ? t : list.querySelector(`${focusSel.split(' ')[0]} button:not([disabled])`))?.focus();
    }
  };
  draw();
  return list;
}

function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

async function renderSettings() {
  $('library').removeAttribute('aria-hidden');
  setTopbarMode('settings');
  $('title').textContent = 'Settings';
  document.title = 'Settings';
  $('upBtn').hidden = false;
  $('path').replaceChildren(el('button', { type: 'button', onclick: () => goBox(ROOT) }, 'My boxes'));

  const [boxes, comics] = await Promise.all([db.all('boxes'), db.all('comics')]);
  let used = comics.reduce((sum, c) => sum + (c.size || 0) + (c.cover ? c.cover.size : 0), 0);
  try { const est = await navigator.storage?.estimate?.(); if (est && est.usage) used = est.usage; } catch { /* fall back to our own count */ }
  const canWake = 'wakeLock' in navigator;
  const pref = settings.readerPref;

  shelf.replaceChildren(
    el('div', { class: 'settings' },
      el('section', { class: 'section set-section' },
        el('div', { class: 'section-head' }, el('h2', {}, 'Home screen')),
        el('p', { class: 'set-note' }, 'The order of the sections on My boxes. Use the arrows to move one up or down, and the switch to hide it.'),
        el('div', { class: 'set-group' }, orderList('homeOrder', SECTIONS.home, 'homeHidden'),
          setRow('Keep reading shows', 'How many unfinished comics to list.',
            segmented('Keep reading shows', [[6, '6'], [12, '12'], [24, '24']], settings.get('readingCount'), (v) => settings.set('readingCount', v))))),

      el('section', { class: 'section set-section' },
        el('div', { class: 'section-head' }, el('h2', {}, 'Inside a box')),
        el('p', { class: 'set-note' }, 'What comes first when you open a box.'),
        el('div', { class: 'set-group' }, orderList('boxOrder', SECTIONS.box))),

      setGroup('Look', null,
        setRow('Theme', 'Match device follows your phone\'s light or dark mode.',
          segmented('Theme', [['light', 'White'], ['dark', 'Black'], ['auto', 'Match device']], settings.getTheme(), (v) => {
            settings.setTheme(v); applyTheme(settings.resolvedTheme());
          }), true),
        setRow('Cover size', 'Bigger covers show fewer per row.',
          segmented('Cover size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], settings.get('coverSize'), (v) => {
            settings.set('coverSize', v); applyCoverSize();
          }), true)),

      setGroup('Sorting', null,
        setRow('Issues', null,
          segmented('Sort issues by', [['name', 'Name'], ['added', 'Newest added'], ['opened', 'Last read']], settings.get('issueSort'), (v) => settings.set('issueSort', v)), true),
        setRow('Boxes', null,
          segmented('Sort boxes by', [['name', 'Name'], ['added', 'Newest']], settings.get('boxSort'), (v) => settings.set('boxSort', v)), true)),

      setGroup('Reader', null,
        setRow('Manga mode', 'Read right to left. You can still switch it for one comic in the reader.',
          toggle(pref.get('rtl', false), 'Manga mode', (v) => pref.set('rtl', v))),
        setRow('Two-page view', 'Show pages side by side on tablets and wide screens held sideways.',
          toggle(pref.get('spread', true), 'Two-page view', (v) => pref.set('spread', v))),
        setRow('Tap the edges to turn pages', 'Turn off if you only want to swipe.',
          toggle(pref.get('tapTurn', true), 'Tap the edges to turn pages', (v) => pref.set('tapTurn', v))),
        setRow('Keep the screen on', canWake ? 'Stops the screen from dimming while you read.' : 'This device or browser doesn\'t allow it.',
          toggle(canWake && pref.get('awake', false), 'Keep the screen on', (v) => pref.set('awake', v), !canWake))),

      setGroup('Library', null,
        setRow('On this device', `${plural(comics.length, 'comic', 'comics')} in ${plural(boxes.length, 'box', 'boxes')}, using about ${formatBytes(used)}.`, null),
        el('button', { class: 'set-action', type: 'button', onclick: async () => {
          if (!await confirmSheet('Mark every comic as unread?', 'Reading progress is cleared for all comics. The comics stay.', 'Mark unread')) return;
          for (const c of await db.all('comics')) if (c.lastPage || c.done) await db.put('comics', { ...c, lastPage: 0, done: false });
          toast('All comics marked as unread');
        } }, 'Mark everything as unread'),
        el('button', { class: 'set-action', type: 'button', onclick: async () => {
          if (!await confirmSheet('Reset settings?', 'Section order, sorting, sizes, theme and reader options go back to how they started. Your comics stay.', 'Reset')) return;
          settings.reset(); settings.setTheme('auto');
          ['rtl', 'spread', 'tapTurn', 'awake'].forEach((k) => { try { localStorage.removeItem(`cb.${k}`); } catch { /* ignore */ } });
          applyTheme(settings.resolvedTheme()); applyCoverSize(); renderSettings(); toast('Settings reset');
        } }, 'Reset settings'),
        el('button', { class: 'set-action danger', type: 'button', onclick: async () => {
          if (!await confirmSheet('Delete all comics and boxes?', 'Everything in Comic Boxes is removed from this device. The original files you added from aren\'t touched.', 'Delete everything')) return;
          for (const b of (await db.all('boxes')).filter((x) => x.parentId === ROOT)) await db.deleteBox(b.id);
          for (const c of await db.all('comics')) await db.deleteComic(c.id);
          for (const id of [...coverUrls.keys()]) forgetCover(id);
          renderSettings(); toast('Library emptied');
        } }, 'Delete all comics and boxes')),

      el('p', { class: 'set-about' }, 'Comic Boxes 2.1. Your comics and settings are kept only on this device.')),
  );
  window.scrollTo(0, 0);
}

// ---------- importing ----------
function showProgress(done, total, name) {
  const panel = $('progressPanel');
  panel.hidden = false;
  $('progressCount').textContent = total ? `${Math.min(done + 1, total)} of ${total}` : 'Looking through files';
  $('progressName').textContent = name || '';
  $('progressFill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
}

async function importEntries(entriesPromise) {
  if (busy) { toast('Still adding the last batch. Try again when it finishes.'); return; }
  busy = true;
  const target = currentBox;
  showProgress(0, 0, '');
  try {
    const entries = await entriesPromise;
    if (!entries.length) return;
    const p = await plan(entries);
    if (!p.jobs.length) {
      toast('No comics found. Comic Boxes reads CBZ, CBR, CB7, CBT, PDF, EPUB and folders of pictures.', 5000);
      return;
    }
    let lastRender = 0;
    const result = await run(p, target, (done, total, name) => {
      showProgress(done, total, name);
      if (done - lastRender >= 4) { lastRender = done; render(); }
    });
    await render();
    toast(summary(result), result.errors.length ? 7000 : 3600);
  } catch (e) {
    console.error(e);
    toast('Those files couldn\'t be added.');
  } finally {
    busy = false;
    $('progressPanel').hidden = true;
  }
}

function summary(r) {
  const bits = [];
  if (r.added) bits.push(`Added ${plural(r.added, 'comic', 'comics')}${r.boxes ? ` and ${plural(r.boxes, 'box', 'boxes')}` : ''}.`);
  else if (r.boxes) bits.push(`Made ${plural(r.boxes, 'box', 'boxes')}.`);
  if (r.skipped) bits.push(`${plural(r.skipped, 'comic was', 'comics were')} already here.`);
  if (r.errors.length) bits.push(r.errors[0] + (r.errors.length > 1 ? ` ${r.errors.length - 1} more couldn't be added.` : ''));
  return bits.join(' ') || 'Nothing new to add.';
}

fileInput.addEventListener('change', () => { importEntries(Promise.resolve(entriesFromFiles(fileInput.files))); fileInput.value = ''; });
folderInput.addEventListener('change', () => { importEntries(Promise.resolve(entriesFromFiles(folderInput.files))); folderInput.value = ''; });

// Drag and drop files or whole folders (Mac, PC, iPad with Split View)
const lib = $('library');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
lib.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; lib.classList.add('dropping'); } });
lib.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; lib.classList.remove('dropping'); } });
lib.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
lib.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  lib.classList.remove('dropping');
  importEntries(entriesFromDrop(e.dataTransfer));
});

// Stop iOS Safari from pinch-zooming the whole interface (the reader has its own zoom).
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- start ----------
db.askPersistentStorage();
if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.Capacitor) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
