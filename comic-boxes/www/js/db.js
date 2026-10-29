// Tiny IndexedDB layer. Everything lives on the device; nothing is uploaded anywhere.
//   boxes:  { id, name, parentId, created }
//   comics: { id, name, boxId, size, pages, lastPage, done, added, cover (Blob), colors [] }
//   files:  { id, blob }   (the original .cbz, stored separately so lists stay fast)
export const ROOT = 'root';

const DB_NAME = 'comic-boxes';
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const boxes = db.createObjectStore('boxes', { keyPath: 'id' });
      boxes.createIndex('parentId', 'parentId');
      const comics = db.createObjectStore('comics', { keyPath: 'id' });
      comics.createIndex('boxId', 'boxId');
      db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function get(storeName, id) {
  return wrap((await store(storeName)).get(id));
}
export async function put(storeName, value) {
  return wrap((await store(storeName, 'readwrite')).put(value));
}
export async function del(storeName, id) {
  return wrap((await store(storeName, 'readwrite')).delete(id));
}
export async function all(storeName) {
  return wrap((await store(storeName)).getAll());
}
export async function byIndex(storeName, index, value) {
  return wrap((await store(storeName)).index(index).getAll(value));
}

// Saves the comic record and its file in one transaction so a half-import never shows up.
export async function addComic(comic, blob) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['comics', 'files'], 'readwrite');
    tx.objectStore('comics').put(comic);
    tx.objectStore('files').put({ id: comic.id, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Storage is full'));
  });
}

export async function deleteComic(id) {
  await del('comics', id);
  await del('files', id);
}

// Deletes a box together with every box and issue inside it.
export async function deleteBox(id) {
  const kids = await byIndex('boxes', 'parentId', id);
  for (const k of kids) await deleteBox(k.id);
  const comics = await byIndex('comics', 'boxId', id);
  for (const c of comics) await deleteComic(c.id);
  await del('boxes', id);
}

// Ids of a box and everything nested under it (used to stop moving a box into itself).
export async function descendantIds(id) {
  const boxes = await all('boxes');
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of boxes) {
      if (out.has(b.parentId) && !out.has(b.id)) { out.add(b.id); grew = true; }
    }
  }
  return out;
}

export async function askPersistentStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch { /* not supported everywhere; fine */ }
}
