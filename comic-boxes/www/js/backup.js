// Backups: the whole library (boxes, comics, covers, reading progress) in one file the person
// keeps outside the app, so deleting the app, clearing the browser or a new phone can't lose it.
//
// File layout (".comicboxes"):
//   "COMIC-BOXES-BACKUP-1\n" + 12-digit length of the list + "\n"
//   the list (JSON: boxes, comics with their sizes, settings)
//   then, for each comic in the list's order: its cover bytes (if any), then its file bytes.
// The file is assembled from the stored comics without reading them into memory, and read back
// in slices, so even very large libraries work on a phone.
import * as db from './db.js';
import { pack, planMerge, saveComic } from './transfer.js';

const MAGIC = 'COMIC-BOXES-BACKUP-1\n';
export const EXT = '.comicboxes';

// iPhones and iPads copy a file into memory to show the Save to Files sheet, so a big backup in
// one piece crashes the app. There it's saved in parts of this size, one tap each. Each part
// starts with a 64-byte label ("COMIC-BOXES-PART-1 <backup id> <part> <of>") and then carries the
// next slice of the one-piece backup, so restoring just puts the slices back together.
const PART_SIZE = 200 * 1024 * 1024;
const PART_MAGIC = 'COMIC-BOXES-PART-1 ';
const PART_HEAD = 64;
export const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

const SETTING_KEYS = ['cb.settings', 'cb.theme', 'cb.rtl', 'cb.spread', 'cb.tapTurn', 'cb.awake'];

export async function makeBackup() {
  const p = await pack({ everything: true });
  const settings = {};
  for (const k of SETTING_KEYS) { try { const v = localStorage.getItem(k); if (v != null) settings[k] = v; } catch { /* ignore */ } }
  const list = {
    app: 'Comic Boxes', version: 1, made: Date.now(), settings,
    boxes: p.boxes,
    comics: p.comics.map(({ file, cover, ...rest }) => rest),
  };
  const json = new TextEncoder().encode(JSON.stringify(list));
  const head = new TextEncoder().encode(`${MAGIC}${String(json.length).padStart(12, '0')}\n`);
  const parts = [head, json];
  for (const c of p.comics) {
    if (c.cover) parts.push(c.cover);
    parts.push(c.file);
  }
  const d = new Date();
  const name = `Comic Boxes backup ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}${EXT}`;
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), name, comics: p.comics.length, boxes: p.boxes.length, bytes: p.bytes };
}

// Hands the file to the person: a download, or on iPhone/iPad the share sheet ("Save to Files").
// The backup as the files to save: one file, or on iPhone/iPad, parts small enough to share.
export function pieces(b) {
  if (!isApple() || b.blob.size <= PART_SIZE) return [{ blob: b.blob, name: b.name }];
  const count = Math.ceil(b.blob.size / PART_SIZE);
  const id = Math.random().toString(36).slice(2, 10);
  const base = b.name.slice(0, -EXT.length);
  return Array.from({ length: count }, (_, i) => {
    const label = `${PART_MAGIC}${id} ${i + 1} ${count}`.padEnd(PART_HEAD - 1, ' ') + '\n';
    return {
      blob: new Blob([label, b.blob.slice(i * PART_SIZE, (i + 1) * PART_SIZE)], { type: 'application/octet-stream' }),
      name: `${base} (part ${i + 1} of ${count})${EXT}`,
    };
  });
}

export async function saveFile(blob, name) {
  if (isApple() && navigator.canShare) {
    const file = new File([blob], name, { type: 'application/octet-stream' });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return 'downloaded';
}

export async function isBackup(file) {
  if (file.name && file.name.toLowerCase().endsWith(EXT)) return true;
  try {
    const head = await file.slice(0, MAGIC.length).text();
    return head === MAGIC || head.startsWith(PART_MAGIC);
  } catch { return false; }
}

// Turns the picked files into whole backups: single files as they are, and parts put back
// together in order. Throws a clear message if some parts are missing.
async function assemble(files) {
  const whole = [];
  const groups = new Map();
  for (const f of files) {
    const head = await f.slice(0, PART_HEAD).text().catch(() => '');
    if (head.startsWith(PART_MAGIC)) {
      const [id, i, n] = head.slice(PART_MAGIC.length).trim().split(' ');
      if (!groups.has(id)) groups.set(id, { n: Number(n), parts: new Map(), name: f.name });
      groups.get(id).parts.set(Number(i), f);
    } else whole.push(f);
  }
  for (const g of groups.values()) {
    if (g.parts.size !== g.n) {
      const missing = Array.from({ length: g.n }, (_, i) => i + 1).filter((i) => !g.parts.has(i));
      throw new Error(`This backup is in ${g.n} parts. Pick all ${g.n} at once (missing: part ${missing.join(', ')}).`);
    }
    const ordered = Array.from({ length: g.n }, (_, i) => g.parts.get(i + 1).slice(PART_HEAD));
    whole.push(new File(ordered, g.name.replace(/ \(part \d+ of \d+\)/, ''), { type: 'application/octet-stream' }));
  }
  return whole;
}

// Restores every backup among the picked files (single files or all the parts of one).
export async function restoreAll(files, onProgress) {
  const out = { added: 0, skipped: 0, settingsRestored: false };
  for (const f of await assemble(files)) {
    const r = await restore(f, onProgress);
    out.added += r.added; out.skipped += r.skipped; out.settingsRestored = out.settingsRestored || r.settingsRestored;
  }
  return out;
}

async function readList(file) {
  const headLen = MAGIC.length + 13;
  const head = await file.slice(0, headLen).text();
  if (!head.startsWith(MAGIC)) throw new Error(`${file.name} isn't a Comic Boxes backup.`);
  const len = parseInt(head.slice(MAGIC.length, MAGIC.length + 12), 10);
  if (!(len > 0)) throw new Error(`${file.name} is damaged.`);
  let list;
  try { list = JSON.parse(await file.slice(headLen, headLen + len).text()); } catch { throw new Error(`${file.name} is damaged.`); }
  if (!list || !Array.isArray(list.comics) || !Array.isArray(list.boxes)) throw new Error(`${file.name} is damaged.`);
  return { list, start: headLen + len };
}

// Adds what's in a backup. Boxes with the same name are joined, comics already here are skipped,
// and settings come back only if this device had no comics yet.
// onProgress(done, total, name)
export async function restore(file, onProgress) {
  const { list, start } = await readList(file);
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  // Where each comic's bytes are in the file.
  const where = new Map();
  let at = start;
  for (const c of list.comics) {
    const cover = n(c.coverSize);
    const size = n(c.fileSize);
    where.set(c.key, { cover: [at, at + cover], file: [at + cover, at + cover + size] });
    at += cover + size;
  }
  if (file.size < at) throw new Error(`${file.name} is incomplete: it may not have finished saving. Make a new backup and try again.`);

  const hadComics = (await db.all('comics')).length > 0;
  const items = await planMerge(list);
  let added = 0;
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    onProgress?.(i, items.length, String(c.meta?.name || ''));
    const w = where.get(c.key);
    const cover = n(c.coverSize) ? file.slice(w.cover[0], w.cover[1], String(c.coverType || 'image/jpeg')) : null;
    const blob = file.slice(w.file[0], w.file[1], String(c.fileType || ''));
    try {
      await saveComic(c, cover, blob);
    } catch {
      throw new Error(`This device ran out of space after restoring ${added} ${added === 1 ? 'comic' : 'comics'}. They're kept.`);
    }
    added++;
  }
  if (!hadComics && list.settings) {
    for (const k of SETTING_KEYS) {
      if (typeof list.settings[k] === 'string') { try { localStorage.setItem(k, list.settings[k]); } catch { /* ignore */ } }
    }
  }
  return { added, skipped: list.comics.length - items.length, made: n(list.made), settingsRestored: !hadComics && !!list.settings };
}
