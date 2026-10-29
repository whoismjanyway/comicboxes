// Memory-friendly ZIP (CBZ) reading and writing.
//
// JSZip reads a whole archive into memory, which is fine on a computer but makes iPhone Safari
// close the page with big comics ("A problem repeatedly occurred"). This reader only loads the
// small table of contents at the end of the file, then reads one page at a time with Blob.slice().
// Pages stored without compression (most CBZ files) are never copied at all.

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const readBytes = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());
const utf8 = new TextDecoder('utf-8');

export const canInflate = typeof DecompressionStream !== 'undefined' && (() => {
  try { new DecompressionStream('deflate-raw'); return true; } catch { return false; }
})();

export class LazyZip {
  static async open(blob) {
    const size = blob.size;
    if (size < 22) throw new Error('not a zip');
    // The "end of central directory" record is in the last 22..65557 bytes.
    const tailStart = Math.max(0, size - 65557);
    const tail = await readBytes(blob, tailStart, size);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');

    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);

    // ZIP64 (archives over 4 GB or with more than 65535 files)
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === SIG_LOC64) {
        const off64 = Number(tail.getBigUint64(loc + 8, true));
        const z = await readBytes(blob, off64, off64 + 56);
        if (z.getUint32(0, true) === SIG_EOCD64) {
          count = Number(z.getBigUint64(32, true));
          cdSize = Number(z.getBigUint64(40, true));
          cdOffset = Number(z.getBigUint64(48, true));
        }
      }
    }
    if (cdOffset + cdSize > size) throw new Error('damaged zip');

    const cd = await readBytes(blob, cdOffset, cdOffset + cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== SIG_CEN) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let compSize = cd.getUint32(p + 20, true);
      let size0 = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
      // ZIP64 sizes/offset live in an "extra field" when the normal ones are maxed out.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = cd.getUint16(e, true);
        const len = cd.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (size0 === 0xffffffff) { size0 = Number(cd.getBigUint64(q, true)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.getBigUint64(q, true)); }
        }
        e += 4 + len;
      }
      entries.push({ name, method, compSize, size: size0, offset, encrypted: !!(flags & 1), dir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return new LazyZip(blob, entries);
  }

  constructor(blob, entries) {
    this.blob = blob;
    this.entries = entries;
  }

  // True if every listed entry can be read by this reader.
  canRead(list = this.entries) {
    return list.every((e) => !e.encrypted && (e.method === 0 || (e.method === 8 && canInflate)));
  }

  // Returns the entry's contents as a Blob, reading only that part of the file.
  async read(entry, type = '') {
    const head = await readBytes(this.blob, entry.offset, entry.offset + 30);
    if (head.getUint32(0, true) !== SIG_LOC) throw new Error('damaged zip');
    const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const data = this.blob.slice(start, start + entry.compSize, type);
    if (entry.method === 0) return data;
    if (entry.method === 8) {
      const stream = data.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const out = await new Response(stream).blob();
      return type ? new Blob([out], { type }) : out;
    }
    throw new Error(`unsupported compression ${entry.method}`);
  }
}

// ---------- writing ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Builds an uncompressed ZIP from [{ name, blob }]. The page images become parts of the new
// Blob directly, so only one picture at a time is ever held in memory (to compute its checksum).
export async function writeZip(files, mimeType = 'application/zip') {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.blob.size;
    const crc = crc32(new Uint8Array(await f.blob.arrayBuffer()));
    if (offset + size > 0xfffffff0) throw new Error('This comic is too big to convert (over 4 GB).');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOC, true);
    local.setUint16(4, 20, true);        // version needed
    local.setUint16(6, 0x0800, true);    // UTF-8 names
    local.setUint16(8, 0, true);         // stored
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, f.blob);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, SIG_CEN, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(cen.buffer, name);

    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: mimeType });
}
