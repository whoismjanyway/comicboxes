// Turns picked files, picked folders, dropped folders and "folder zips" into boxes and comics.
//
//   Fantastic Four comics/            → box "Fantastic Four comics"
//     Fantastic Four 001.cbr          →   comic
//     Annuals/                        →   box "Annuals" inside it
//       Annual 01.cbz                 →     comic
//     FF 050 (scans)/                 →   folder of only pictures → one comic "FF 050 (scans)"
//       001.jpg, 002.jpg ...
//
// Boxes that already exist with the same name are reused, and comics that are already in the
// box (same file name and size) are skipped, so importing the same folder twice is safe.

import * as db from './db.js';
import { COMIC_RE, IMAGE_RE, isJunk, importComic, fromImages, expandFolderZip, prettyName, ImportError } from './comic.js';

const folderName = (s) => s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';

// Entry = { path: 'Folder/Sub/file.cbz', name: 'file.cbz', size, load: () => Promise<File> }
export function entriesFromFiles(fileList) {
  return [...fileList].map((f) => ({
    path: f.webkitRelativePath || f.name,
    name: f.name,
    size: f.size,
    load: async () => f,
  }));
}

// Must be called synchronously inside the drop handler (the browser clears the items afterwards).
export function entriesFromDrop(dataTransfer) {
  const roots = [...(dataTransfer.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  const plain = [...dataTransfer.files];
  return (async () => {
    if (!roots.length) return entriesFromFiles(plain);
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: prefix + f.name, name: f.name, size: f.size, load: async () => f });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          if (!batch.length) break;
          for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
        }
      }
    };
    for (const r of roots) await walk(r, '');
    return out;
  })();
}

const node = (name) => ({ name, dirs: new Map(), files: [] });

function hasContent(n) {
  return n.files.some((f) => COMIC_RE.test(f.name) || IMAGE_RE.test(f.name)) || [...n.dirs.values()].some(hasContent);
}

// Works out what to create. Returns a list of jobs, each with the box path it goes into.
export async function plan(entries) {
  const expanded = [];
  for (const e of entries) {
    if (isJunk(e.path)) continue;
    if (/\.zip$/i.test(e.name)) {
      const inner = await expandFolderZip(await e.load(), e.path.slice(0, e.path.length - e.name.length));
      if (inner) { expanded.push(...inner.filter((x) => !isJunk(x.path))); continue; }
    }
    expanded.push(e);
  }

  const root = node('');
  for (const e of expanded) {
    const parts = e.path.split('/').filter(Boolean);
    parts.pop();
    let n = root;
    for (const p of parts) {
      if (!n.dirs.has(p)) n.dirs.set(p, node(p));
      n = n.dirs.get(p);
    }
    n.files.push(e);
  }

  const jobs = [];
  let ignored = 0;
  const walk = (n, boxPath, isRoot) => {
    const comics = n.files.filter((f) => COMIC_RE.test(f.name));
    const images = n.files.filter((f) => IMAGE_RE.test(f.name));
    const dirs = [...n.dirs.values()].filter(hasContent);
    ignored += n.files.length - comics.length - images.length;

    if (!isRoot && !comics.length && !dirs.length && images.length) {
      // A folder with only pictures in it is one comic.
      jobs.push({ kind: 'images', name: folderName(n.name), files: images, boxPath,
        size: images.reduce((s, f) => s + (f.size || 0), 0) });
      return;
    }
    if (isRoot && images.length && !comics.length && !dirs.length) {
      // Loose pictures picked on their own: make them one comic named after the first file.
      jobs.push({ kind: 'images', name: prettyName(images[0].name), files: images, boxPath,
        size: images.reduce((s, f) => s + (f.size || 0), 0) });
      return;
    }
    if (images.length && comics.length) ignored += images.length; // e.g. a folder.jpg next to the comics
    const here = isRoot ? boxPath : [...boxPath, folderName(n.name)];
    for (const c of comics) jobs.push({ kind: 'file', entry: c, name: prettyName(c.name), boxPath: here, size: c.size });
    for (const d of dirs) walk(d, here, false);
  };
  walk(root, [], true);
  return { jobs, ignored };
}

// Creates the boxes and imports the comics. onProgress(done, total, name)
export async function run({ jobs }, baseBoxId, onProgress = () => {}) {
  const boxIds = new Map();
  const result = { added: 0, skipped: 0, boxes: 0, errors: [] };

  const ensureBox = async (path) => {
    let parent = baseBoxId;
    for (let i = 0; i < path.length; i++) {
      const key = path.slice(0, i + 1).join('/');
      if (!boxIds.has(key)) {
        const siblings = await db.byIndex('boxes', 'parentId', parent);
        const existing = siblings.find((b) => b.name.toLowerCase() === path[i].toLowerCase());
        let id = existing && existing.id;
        if (!id) {
          id = db.uid();
          await db.put('boxes', { id, name: path[i], parentId: parent, created: Date.now() });
          result.boxes++;
        }
        boxIds.set(key, id);
      }
      parent = boxIds.get(key);
    }
    return parent;
  };

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress(i, jobs.length, job.name);
    try {
      const boxId = await ensureBox(job.boxPath);
      const origName = job.kind === 'file' ? job.entry.name : job.name;
      const already = (await db.byIndex('comics', 'boxId', boxId))
        .some((c) => c.origName === origName && (!job.size || c.origSize === job.size));
      if (already) { result.skipped++; continue; }

      const info = job.kind === 'file'
        ? await importComic(await job.entry.load())
        : await fromImages(job.name, job.files);

      await db.addComic({
        id: db.uid(), name: job.name, boxId, pages: info.pages, format: info.format, source: info.source,
        origName, origSize: job.size || info.blob.size, size: info.blob.size,
        lastPage: 0, done: false, added: Date.now(), cover: info.cover, color: info.color, ratio: info.ratio,
      }, info.blob);
      result.added++;
    } catch (e) {
      console.warn(e);
      const quota = e && (e.name === 'QuotaExceededError' || /quota|storage is full/i.test(e.message || ''));
      result.errors.push(quota
        ? 'The device is out of storage space.'
        : (e instanceof ImportError ? e.message : `${job.name} couldn't be read. The file may be damaged.`));
      if (quota) break;
    }
  }
  onProgress(jobs.length, jobs.length, '');
  return result;
}
