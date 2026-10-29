// Reads CBR (RAR 4 and RAR 5) comics one page at a time, without loading the whole file.
//
// A RAR file is a list of [header][data] blocks, one per page. This reader walks the headers
// (a few KB each) and remembers where every page lives in the file.
//
//  - Pages stored without compression are cut straight out of the file with Blob.slice().
//  - Compressed pages: unless the archive is "solid", each page is compressed on its own. So a
//    tiny RAR containing just that one page is put together from slices of the original
//    (signature + archive header + that page's block + end marker) and decoded by libarchive.
//    Memory use stays around the size of one page, even for a 1 GB CBR.
//
// Solid, split or password-protected archives return null; the caller decides what to do.

const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const HEADER_READ = 8192; // more than enough for any single header

const bytesAt = async (blob, start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
const starts = (b, sig) => sig.every((x, i) => b[i] === x);

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

/**
 * @param {Blob} blob
 * @param {(mini: Blob) => Promise<Blob>} decode  decodes a one-file RAR and returns that file
 */
export async function lazyRar(blob, decode) {
  const head = await bytesAt(blob, 0, 8);
  try {
    if (starts(head, SIG5)) return await rar5(blob, decode);
    if (starts(head, SIG4)) return await rar4(blob, decode);
  } catch {
    return null;
  }
  return null;
}

// ---------- RAR 4 ----------
// End-of-archive block: CRC, type 0x7b, flags 0x4000, size 7.
const RAR4_END = (() => {
  const h = new Uint8Array([0x7b, 0x00, 0x40, 0x07, 0x00]);
  const c = crc32(h) & 0xffff;
  return new Uint8Array([c & 0xff, c >> 8, ...h]);
})();

async function rar4(blob, decode) {
  const entries = [];
  let mainEnd = 7;
  let pos = 7;
  while (pos + 7 <= blob.size) {
    const h = await bytesAt(blob, pos, HEADER_READ);
    const v = new DataView(h.buffer);
    const type = h[2];
    const flags = v.getUint16(3, true);
    const headSize = v.getUint16(5, true);
    if (headSize < 7) return null;
    let addSize = 0;

    if (type === 0x73) { // archive header
      if (flags & 0x0080) return null; // encrypted headers
      if (flags & 0x0008) return null; // solid archive
      if (flags & 0x0001) return null; // multi-volume
      mainEnd = pos + headSize;
    } else if (type === 0x74) { // file
      let packSize = v.getUint32(7, true);
      const method = h[25];
      const nameSize = v.getUint16(26, true);
      let nameAt = 32;
      if (flags & 0x0100) { packSize += v.getUint32(32, true) * 2 ** 32; nameAt = 40; }
      const isDir = (flags & 0x00e0) === 0x00e0;
      if (!isDir) {
        if (flags & 0x0004) return null;            // password
        if (flags & 0x0003) return null;            // split across volumes
        if (flags & 0x0010) return null;            // solid
        let raw = h.subarray(nameAt, nameAt + nameSize);
        if (flags & 0x0200) { const z = raw.indexOf(0); if (z >= 0) raw = raw.subarray(0, z); } // unicode name: use the plain part
        const name = new TextDecoder('utf-8').decode(raw).replace(/\\/g, '/');
        entries.push({
          name, stored: method === 0x30,
          dataStart: pos + headSize, dataEnd: pos + headSize + packSize, blockStart: pos,
        });
      }
      addSize = packSize;
    } else if (type === 0x7b) { // end of archive
      break;
    } else if (flags & 0x8000) {
      addSize = v.getUint32(7, true);
    }
    pos += headSize + addSize;
  }
  const prefix = blob.slice(0, mainEnd);
  return reader(blob, entries, decode, (e) => new Blob([prefix, blob.slice(e.blockStart, e.dataEnd), RAR4_END]));
}

// ---------- RAR 5 ----------
function vint(b, p) {
  let value = 0, shift = 1, i = p;
  for (;;) {
    const byte = b[i++];
    value += (byte & 0x7f) * shift;
    if (!(byte & 0x80)) break;
    shift *= 128;
    if (i - p > 10) throw new Error('bad vint');
  }
  return [value, i];
}
// End-of-archive header: CRC32, size 3, type 5, flags 0, end flags 0.
const RAR5_END = (() => {
  const body = new Uint8Array([0x03, 0x05, 0x00, 0x00]);
  const c = crc32(body);
  return new Uint8Array([c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, c >>> 24, ...body]);
})();

async function rar5(blob, decode) {
  const entries = [];
  let mainEnd = 8;
  let pos = 8;
  while (pos + 7 <= blob.size) {
    const h = await bytesAt(blob, pos, HEADER_READ);
    let [size, p] = vint(h, 4);
    const headerEnd = p + size;
    let type, flags, extraSize = 0, dataSize = 0;
    [type, p] = vint(h, p);
    [flags, p] = vint(h, p);
    if (flags & 0x01) [extraSize, p] = vint(h, p);
    if (flags & 0x02) [dataSize, p] = vint(h, p);

    if (type === 4) return null; // archive is encrypted
    if (type === 1) { // main header
      const [archFlags] = vint(h, p);
      if (archFlags & 0x0001) return null; // multi-volume
      if (archFlags & 0x0004) return null; // solid
      mainEnd = pos + headerEnd;
    } else if (type === 2) { // file
      if (flags & 0x18) return null; // split across volumes
      let fileFlags, comp, nameLen;
      [fileFlags, p] = vint(h, p);
      [, p] = vint(h, p);   // unpacked size
      [, p] = vint(h, p);   // attributes
      if (fileFlags & 0x02) p += 4; // modification time
      if (fileFlags & 0x04) p += 4; // CRC32
      [comp, p] = vint(h, p);
      [, p] = vint(h, p);   // host OS
      [nameLen, p] = vint(h, p);
      const name = new TextDecoder('utf-8').decode(h.subarray(p, p + nameLen));
      // Extra area records: type 1 means the file is encrypted.
      let e = headerEnd - extraSize;
      while (extraSize && e < headerEnd) {
        let recSize, recType;
        [recSize, e] = vint(h, e);
        const recEnd = e + recSize;
        [recType] = vint(h, e);
        if (recType === 1) return null;
        e = recEnd;
      }
      if (!(fileFlags & 0x01)) { // not a directory
        if (comp & 0x40) return null; // solid
        const method = (comp >> 7) & 0x07;
        entries.push({
          name, stored: method === 0,
          dataStart: pos + headerEnd, dataEnd: pos + headerEnd + dataSize, blockStart: pos,
        });
      }
    } else if (type === 5) { // end of archive
      break;
    }
    pos += headerEnd + dataSize;
  }
  const prefix = blob.slice(0, mainEnd);
  return reader(blob, entries, decode, (e) => new Blob([prefix, blob.slice(e.blockStart, e.dataEnd), RAR5_END]));
}

function reader(blob, entries, decode, miniArchive) {
  return {
    entries,
    // True when no page needs decompressing (no libarchive needed at all).
    allStored: entries.every((e) => e.stored),
    async read(entry, type = '') {
      if (entry.stored) return blob.slice(entry.dataStart, entry.dataEnd, type);
      if (!decode) throw new Error('compressed page');
      const out = await decode(miniArchive(entry));
      return type ? new Blob([out], { type }) : out;
    },
  };
}
