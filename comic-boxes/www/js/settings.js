// User settings, saved on this device (localStorage). Every read has a safe default,
// so the app works the same in private browsing where storage may be unavailable.

export const SECTIONS = {
  home: [
    { id: 'boxes', label: 'Boxes', canHide: false },
    { id: 'reading', label: 'Keep reading', canHide: true },
    { id: 'loose', label: 'Not in a box', canHide: true },
  ],
  box: [
    { id: 'boxes', label: 'Boxes inside it' },
    { id: 'issues', label: 'Issues' },
  ],
};

const DEFAULTS = {
  homeOrder: ['boxes', 'reading', 'loose'],
  homeHidden: [],
  boxOrder: ['boxes', 'issues'],
  issueSort: 'name',     // name | added | opened
  boxSort: 'name',       // name | added
  coverSize: 'medium',   // small | medium | large
  readingCount: 12,
};

const KEY = 'cb.settings';
let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  cache = { ...DEFAULTS, ...saved };
  // Keep order lists valid if sections are added or removed in a later version.
  cache.homeOrder = fixOrder(cache.homeOrder, SECTIONS.home);
  cache.boxOrder = fixOrder(cache.boxOrder, SECTIONS.box);
  return cache;
}

function fixOrder(order, all) {
  const ids = all.map((s) => s.id);
  const kept = (Array.isArray(order) ? order : []).filter((id) => ids.includes(id));
  return [...new Set([...kept, ...ids])];
}

export function get(name) {
  return load()[name];
}

export function set(name, value) {
  load()[name] = value;
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* private mode: lasts until the page closes */ }
}

export function reset() {
  cache = { ...DEFAULTS };
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

// Reader options live under their own keys ('1'/'0'), which the reader already uses.
export const readerPref = {
  get(name, fallback) {
    try { const v = localStorage.getItem(`cb.${name}`); return v == null ? fallback : v === '1'; } catch { return fallback; }
  },
  set(name, on) {
    try { localStorage.setItem(`cb.${name}`, on ? '1' : '0'); } catch { /* ignore */ }
  },
};

// Theme: 'light', 'dark' or 'auto' (follow the device).
export function getTheme() {
  try { const t = localStorage.getItem('cb.theme'); return t === 'light' || t === 'dark' ? t : 'auto'; } catch { return 'auto'; }
}
export function setTheme(t) {
  try {
    if (t === 'auto') localStorage.removeItem('cb.theme'); else localStorage.setItem('cb.theme', t);
  } catch { /* ignore */ }
}
export function resolvedTheme() {
  const t = getTheme();
  if (t !== 'auto') return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
