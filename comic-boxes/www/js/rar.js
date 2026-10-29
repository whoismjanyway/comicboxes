// Reads CBR (RAR 4 and RAR 5) files whose pages are stored without compression, which is how
// most comic RARs are made (JPG/PNG pages don't shrink further). Pages are taken straight out of
// the file with Blob.slice(), so a 500 MB CBR uses almost no memory.
//
// Compressed, solid, split or password-protected archives return null, and the caller falls
// back to the full libarchive decoder.

const SIG4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const SIG5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
const HEADER_READ = 4096; // more than enough for any single header

const bytesAt = async (blob, start, len) => new Uint8Array(await blob.slice(start, start + len).arrayBuffer());
const starts = (b, sig) => sig.every((x, i) => b[i] === x);

export async function lazyRar(blob) {
  const head = await bytesAt(blob, 0, 8);
  try {
    if (starts(head, SIG5)) return await rar5(blob);
    if (starts(head, SIG4)) return await rar4(blob);
  } catch {
    return null;
  }
  return null;
}

// ---------- RAR 4 ----------
async function rar4(blob) {
  const entries = [];
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
        if (method !== 0x30) return null;           // compressed
        let raw = h.subarray(nameAt, nameAt + nameSize);
        if (flags & 0x0200) { const z = raw.indexOf(0); if (z >= 0) raw = raw.subarray(0, z); } // unicode name: use the plain part
        const name = new TextDecoder('utf-8').decode(raw).replace(/\\/g, '/');
        entries.push({ name, offset: pos + headSize, size: packSize });
      }
      addSize = packSize;
    } else if (type === 0x7b) { // end of archive
      break;
    } else if (flags & 0x8000) {
      addSize = v.getUint32(7, true);
    }
    pos += headSize + addSize;
  }
  return reader(blob, entries);
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

async function rar5(blob) {
  const entries = [];
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
    } else if (type === 2) { // file
      if (flags & 0x18) return null; // split across volumes
      let fileFlags, attrs, comp, host, nameLen;
      [fileFlags, p] = vint(h, p);
      [, p] = vint(h, p);   // unpacked size
      [attrs, p] = vint(h, p);
      if (fileFlags & 0x02) p += 4; // modification time
      if (fileFlags & 0x04) p += 4; // CRC32
      [comp, p] = vint(h, p);
      [host, p] = vint(h, p);
      [nameLen, p] = vint(h, p);
      const name = new TextDecoder('utf-8').decode(h.subarray(p, p + nameLen));
      p += nameLen;
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
      void attrs; void host;
      if (!(fileFlags & 0x01)) { // not a directory
        const method = (comp >> 7) & 0x07;
        const solid = comp & 0x40;
        if (method !== 0 || solid) return null;
        entries.push({ name, offset: pos + headerEnd, size: dataSize });
      }
    } else if (type === 5) { // end of archive
      break;
    }
    pos += headerEnd + dataSize;
  }
  return reader(blob, entries);
}

function reader(blob, entries) {
  return {
    entries,
    read: (entry, type = '') => Promise.resolve(blob.slice(entry.offset, entry.offset + entry.size, type)),
  };
}
