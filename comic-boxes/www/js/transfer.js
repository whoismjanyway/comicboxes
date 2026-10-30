// Sending boxes and issues straight to another device on the same Wi-Fi.
//
// How it stays on Wi-Fi and off the internet:
//   - The two devices connect directly with WebRTC. No STUN, TURN or any other server is set,
//     so there is nothing on the internet to connect through.
//   - The devices swap connection details by showing each other a QR code. Only local network
//     addresses are put in the codes and accepted from them (192.168.x.x, 10.x.x.x, 172.16-31.x.x,
//     link-local, and the private ".local" names browsers use). Public and mobile-carrier
//     addresses (including 100.64.x.x) are dropped, so a link can only form inside one network.
//   - Phones that say they are on mobile data (Android) are stopped before anything starts,
//     and a transfer stops if the phone switches to mobile data part way through.
//   - After connecting, the route actually picked is checked once more.
// Everything sent is encrypted by WebRTC (DTLS). Nothing is stored anywhere but the two devices.
import * as db from './db.js';
import { ROOT } from './db.js';

const RTC_CONFIG = { iceServers: [], iceCandidatePoolSize: 0 };
const VERSION = 'CB1';
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

// ---------- Wi-Fi only ----------
const MOBILE_TYPES = new Set(['cellular', 'wimax']);

// Why a transfer can't start right now, or null if it can.
export function networkProblem() {
  const c = navigator.connection;
  if (c && MOBILE_TYPES.has(c.type)) {
    return 'This device is on mobile data. Comics are only sent over Wi-Fi. Connect both devices to the same Wi-Fi and try again.';
  }
  if ((c && c.type === 'none') || navigator.onLine === false) {
    return 'This device isn\'t on a Wi-Fi network. Connect both devices to the same Wi-Fi and try again.';
  }
  return null;
}

// Calls onLost(message) if the device leaves Wi-Fi for mobile data or loses the network.
export function watchNetwork(onLost) {
  const c = navigator.connection;
  const check = () => { const p = networkProblem(); if (p) onLost(p); };
  c?.addEventListener?.('change', check);
  window.addEventListener('offline', check);
  return () => { c?.removeEventListener?.('change', check); window.removeEventListener('offline', check); };
}

export function isLocalAddress(addr) {
  if (!addr) return false;
  let a = String(addr).trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (a.endsWith('.local')) return true;
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    return p === 10 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 169 && q === 254);
  }
  if (a.includes(':')) {
    a = a.split('%')[0];
    return /^fe[89ab]/.test(a) || /^f[cd]/.test(a);
  }
  return false;
}

// ---------- connection details in a QR code ----------
// A full WebRTC description is long, so only the few parts that matter are put in the code
// ("CB1|o|mid|ufrag|pwd|fingerprint|host/port,host/port") and the rest is rebuilt on the other side.
const toB64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');

function compact(desc) {
  const lines = desc.sdp.split(/\r?\n/);
  const get = (prefix) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length).trim();
  const fp = get('a=fingerprint:') || '';
  const [algo, value = ''] = fp.split(' ');
  if (algo.toLowerCase() !== 'sha-256') throw new Error('This browser can\'t make a secure link.');
  const fingerprint = toB64(value.split(':').map((h) => parseInt(h, 16)));
  const seen = new Set();
  const cands = [];
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    const [, component, protocol, , address, port, , type] = l.slice(12).split(' ');
    const key = `${address}/${port}`;
    if (component === '1' && protocol.toLowerCase() === 'udp' && type === 'host' && isLocalAddress(address) && !seen.has(key)) {
      seen.add(key);
      cands.push(key);
    }
  }
  // o = offer; a / p = an answer that starts (active) or waits for (passive) the secure handshake.
  const kind = desc.type === 'offer' ? 'o' : get('a=setup:') === 'passive' ? 'p' : 'a';
  const text = [VERSION, kind, get('a=mid:') || '0', get('a=ice-ufrag:'), get('a=ice-pwd:'), fingerprint, cands.join(',')].join('|');
  return { text, fingerprint, count: cands.length };
}

export function readCode(text, want) {
  const parts = String(text || '').trim().split('|');
  if (parts.length !== 7 || parts[0] !== VERSION) throw new Error('That isn\'t a Comic Boxes code.');
  const [, kind, mid, ufrag, pwd, fingerprint, list] = parts;
  if (!['o', 'a', 'p'].includes(kind) || (want === 'offer') !== (kind === 'o')) {
    throw new Error(want === 'offer'
      ? 'That code is a reply. Scan the code on the device that tapped Receive.'
      : 'That code is from a device that is also receiving. Scan the code on the sending device.');
  }
  if (!/^[A-Za-z0-9+/]{4,256}$/.test(ufrag) || !/^[A-Za-z0-9+/]{22,256}$/.test(pwd) || !/^[A-Za-z0-9_-]{43}$/.test(fingerprint) || !/^[\w-]{1,32}$/.test(mid)) {
    throw new Error('That code is damaged. Try scanning it again.');
  }
  const cands = list.split(',').filter(Boolean).map((c) => {
    const i = c.lastIndexOf('/');
    return { address: c.slice(0, i), port: Number(c.slice(i + 1)) };
  }).filter((c) => isLocalAddress(c.address) && /^[\w.:-]+$/.test(c.address) && c.port > 0 && c.port < 65536);
  if (!cands.length) {
    throw new Error('The other device isn\'t on a Wi-Fi network. Connect both devices to the same Wi-Fi.');
  }
  const sdp = [
    'v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0',
    `a=group:BUNDLE ${mid}`, 'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    ...cands.map((c, i) => `a=candidate:${i + 1} 1 udp ${2122260223 - i * 256} ${c.address} ${c.port} typ host generation 0`),
    'a=end-of-candidates',
    `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${hex(fromB64(fingerprint))}`,
    `a=setup:${{ o: 'actpass', a: 'active', p: 'passive' }[kind]}`,
    `a=mid:${mid}`, 'a=sctp-port:5000', 'a=max-message-size:65536', '',
  ].join('\r\n');
  return { type: kind === 'o' ? 'offer' : 'answer', sdp, fingerprint };
}

function gathered(pc, ms = 4000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const t = setTimeout(resolve, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
    });
  });
}

const NO_WIFI = 'No Wi-Fi network found on this device. Connect to Wi-Fi and try again.';

// A link between this device and one other. The receiving device makes the first code
// (makeOffer), the sending device answers it (makeAnswer), then the receiver reads the
// answer (link.finish) and both wait for link.open().
class Link {
  constructor() {
    if (!('RTCPeerConnection' in window)) throw new Error('This browser can\'t connect to other devices.');
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.dc = null;
    this.code = '';
    this.myPrint = '';
    this.theirPrint = '';
    // Messages can arrive the moment the channel opens, before anyone is reading them,
    // so start keeping them right away.
    this.channel = new Promise((resolve) => {
      this.pc.addEventListener('datachannel', (e) => resolve(e.channel));
      this.setChannel = resolve;
    }).then((ch) => {
      ch.binaryType = 'arraybuffer';
      ch.early = [];
      ch.keepEarly = (e) => ch.early.push(e.data);
      ch.addEventListener('message', ch.keepEarly);
      return ch;
    });
  }

  async describe(desc) {
    await this.pc.setLocalDescription(desc);
    await gathered(this.pc);
    const c = compact(this.pc.localDescription);
    if (!c.count) throw new Error(NO_WIFI);
    this.code = c.text;
    this.myPrint = c.fingerprint;
  }

  // Receiver: reads the code shown by the sender.
  async finish(text) {
    const remote = readCode(text, 'answer');
    this.theirPrint = remote.fingerprint;
    await this.pc.setRemoteDescription({ type: 'answer', sdp: remote.sdp });
  }

  // Resolves with an open data channel, after checking the route is local.
  async open(ms = 25000) {
    const dc = await withTimeout(this.channel.then((ch) => new Promise((resolve, reject) => {
      if (ch.readyState === 'open') { resolve(ch); return; }
      ch.addEventListener('open', () => resolve(ch), { once: true });
      ch.addEventListener('error', () => reject(new Error('The connection failed.')), { once: true });
    })), ms, 'Couldn\'t connect. Check that both devices are on the same Wi-Fi. Guest and public Wi-Fi often keep devices apart; a home network or a phone\'s hotspot works.');
    await this.checkRoute();
    return dc;
  }

  async checkRoute() {
    try {
      const stats = await this.pc.getStats();
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.selected || s.nominated)) pair = s; });
      if (!pair) return;
      for (const id of [pair.localCandidateId, pair.remoteCandidateId]) {
        const c = stats.get(id);
        const addr = c && (c.address || c.ip);
        if (addr && !isLocalAddress(addr)) {
          this.close();
          throw new Error('The devices could only reach each other through the internet, so nothing was sent. Connect both to the same Wi-Fi.');
        }
      }
    } catch (e) {
      if (/internet/.test(e.message)) throw e;
      // Some browsers don't report the route; the codes already only allow local addresses.
    }
  }

  async pairCode() {
    const both = [this.myPrint, this.theirPrint].sort().join('.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(both)));
    return String(((digest[0] << 16) | (digest[1] << 8) | digest[2]) % 10000).padStart(4, '0');
  }

  close() {
    try { this.dc?.close(); } catch { /* already closed */ }
    try { this.pc.close(); } catch { /* already closed */ }
  }
}

// True if this device has a home-network address to connect from. Checked before a short code
// is looked up online, so a device that isn't on Wi-Fi doesn't contact the relay at all.
export async function hasWifiAddress() {
  if (!('RTCPeerConnection' in window)) return false;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  try {
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc, 3000);
    return compact(pc.localDescription).count > 0;
  } catch { return false; } finally { pc.close(); }
}

export async function makeOffer() {
  const link = new Link();
  link.dc = link.pc.createDataChannel('comic-boxes', { ordered: true });
  link.setChannel(link.dc);
  try {
    await link.describe(await link.pc.createOffer());
  } catch (e) { link.close(); throw e; }
  return link;
}

export async function makeAnswer(text) {
  const remote = readCode(text, 'offer');
  const link = new Link();
  try {
    link.theirPrint = remote.fingerprint;
    await link.pc.setRemoteDescription({ type: 'offer', sdp: remote.sdp });
    await link.describe(await link.pc.createAnswer());
  } catch (e) { link.close(); throw e; }
  return link;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// ---------- messages over the link ----------
class Wire {
  constructor(dc, pc) {
    this.dc = dc;
    this.pc = pc;
    this.inbox = [];
    this.waiting = null;
    this.closed = false;
    this.reason = '';
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_WATER;
    const onMessage = (data) => {
      let msg = data;
      if (typeof msg === 'string') {
        try { msg = JSON.parse(msg); } catch { return; }
        if (msg.t === 'error') this.reason = String(msg.message || '').slice(0, 200);
      }
      if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(msg); } else this.inbox.push(msg);
    };
    if (dc.keepEarly) dc.removeEventListener('message', dc.keepEarly);
    for (const data of dc.early || []) onMessage(data);
    dc.early = [];
    dc.addEventListener('message', (e) => onMessage(e.data));
    const onClose = () => {
      if (this.closed) return;
      this.closed = true;
      if (this.waiting) { const w = this.waiting; this.waiting = null; w.reject(this.lost()); }
      this.onClose?.();
    };
    dc.addEventListener('close', onClose);
    pc.addEventListener('connectionstatechange', () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) onClose();
    });
  }

  lost() { return new Error(this.reason || 'The connection to the other device was lost.'); }

  get chunk() {
    const max = this.pc.sctp?.maxMessageSize;
    return Math.max(16 * 1024, Math.min(64 * 1024, Number.isFinite(max) && max > 0 ? max : 16 * 1024));
  }

  send(obj) {
    if (this.closed) throw this.lost();
    this.dc.send(JSON.stringify(obj));
  }

  async sendBytes(buf) {
    if (this.closed) throw this.lost();
    if (this.dc.bufferedAmount > HIGH_WATER) {
      await new Promise((resolve) => {
        const done = () => { this.dc.removeEventListener('bufferedamountlow', done); clearInterval(poll); resolve(); };
        const poll = setInterval(() => { if (this.closed || this.dc.bufferedAmount <= LOW_WATER) done(); }, 250);
        this.dc.addEventListener('bufferedamountlow', done);
      });
      if (this.closed) throw this.lost();
    }
    this.dc.send(buf);
  }

  next(ms = 0) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    if (this.closed) return Promise.reject(this.lost());
    const p = new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
    return ms ? withTimeout(p, ms, 'The other device stopped answering.') : p;
  }

  async expect(type, ms) {
    const msg = await this.next(ms);
    if (!msg || msg instanceof ArrayBuffer || msg.t === 'error') throw this.lost();
    if (msg.t !== type) throw new Error('The other device sent something unexpected. Make sure both have the newest Comic Boxes.');
    return msg;
  }

  // Waits for everything queued to actually leave this device.
  async drain() {
    while (!this.closed && this.dc.bufferedAmount > 0) await new Promise((r) => setTimeout(r, 100));
  }
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/CrOS|Linux/.test(ua)) return 'A computer';
  return 'Another device';
}

// ---------- what gets sent ----------
// Fields of a comic record that travel with it. Reading progress comes along.
const META_FIELDS = ['name', 'pages', 'format', 'source', 'origName', 'origSize', 'lastPage', 'done', 'opened', 'color', 'colors', 'ratio'];
const pickMeta = (c) => Object.fromEntries(META_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

// item = { box } or { comic }. Returns what will be sent, without reading any comic files yet.
export async function pack(item) {
  const boxes = [];
  const comics = [];
  const addComic = async (c, boxKey) => {
    const file = await db.get('files', c.id);
    if (!file || !file.blob) return;
    comics.push({
      key: c.id, box: boxKey, meta: pickMeta(c), added: c.added || 0,
      fileSize: file.blob.size, fileType: file.blob.type || '',
      coverSize: c.cover ? c.cover.size : 0, coverType: c.cover ? c.cover.type || 'image/jpeg' : '',
      file: file.blob, cover: c.cover || null,
    });
  };
  if (item.everything) {
    // The whole library, top-level boxes first so every box comes after the one it's in.
    const all = await db.all('boxes');
    const queue = all.filter((b) => b.parentId === ROOT);
    while (queue.length) {
      const b = queue.shift();
      boxes.push({ key: b.id, name: b.name, parent: b.parentId === ROOT ? null : b.parentId });
      for (const c of await db.byIndex('comics', 'boxId', b.id)) await addComic(c, b.id);
      queue.push(...all.filter((x) => x.parentId === b.id));
    }
    for (const c of await db.byIndex('comics', 'boxId', ROOT)) await addComic(c, null);
  } else if (item.box) {
    const all = await db.all('boxes');
    const queue = [item.box];
    while (queue.length) {
      const b = queue.shift();
      boxes.push({ key: b.id, name: b.name, parent: b.id === item.box.id ? null : b.parentId });
      for (const c of await db.byIndex('comics', 'boxId', b.id)) await addComic(c, b.id);
      queue.push(...all.filter((x) => x.parentId === b.id));
    }
  } else {
    const c = item.comic;
    let boxKey = null;
    if (c.boxId !== ROOT) {
      const b = await db.get('boxes', c.boxId);
      if (b) { boxes.push({ key: b.id, name: b.name, parent: null }); boxKey = b.id; }
    }
    await addComic(c, boxKey);
  }
  const bytes = comics.reduce((s, c) => s + c.fileSize + c.coverSize, 0);
  const title = item.everything ? 'My boxes' : item.box ? item.box.name : item.comic.name;
  return { title, kind: item.everything ? 'library' : item.box ? 'box' : 'issue', boxes, comics, bytes };
}

// ---------- sending ----------
// onProgress(sentBytes, totalBytes, comicName, index, count)
export async function send(dc, pc, p, onProgress) {
  const wire = new Wire(dc, pc);
  wire.send({ t: 'hello', v: 1, from: deviceName(), title: p.title, kind: p.kind, boxes: p.boxes.length, issues: p.comics.length, bytes: p.bytes });
  const answer = await wire.next();
  if (answer && answer.t === 'decline') return { declined: true, reason: answer.reason };
  if (!answer || answer.t !== 'accept') throw wire.lost();

  wire.send({
    t: 'manifest',
    boxes: p.boxes,
    comics: p.comics.map(({ file, cover, ...rest }) => rest),
  });
  const { keys } = await wire.expect('need');
  const wanted = new Set(keys);
  const todo = p.comics.filter((c) => wanted.has(c.key));
  const total = todo.reduce((s, c) => s + c.fileSize + c.coverSize, 0);
  let sent = 0;
  const step = wire.chunk;
  for (let i = 0; i < todo.length; i++) {
    const c = todo[i];
    wire.send({ t: 'item', key: c.key });
    for (const blob of [c.cover, c.file]) {
      if (!blob) continue;
      for (let at = 0; at < blob.size; at += step) {
        const buf = await blob.slice(at, at + step).arrayBuffer();
        await wire.sendBytes(buf);
        sent += buf.byteLength;
        onProgress?.(sent, total, c.meta.name, i, todo.length);
      }
    }
  }
  wire.send({ t: 'done' });
  await wire.drain();
  const bye = await wire.expect('bye', 5 * 60 * 1000);
  return { added: bye.added || 0, skipped: p.comics.length - todo.length };
}

// ---------- receiving ----------
const str = (v, max = 300) => String(v ?? '').slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

// confirm(hello) → Promise<boolean>. onProgress(gotBytes, totalBytes, comicName, index, count)
export async function receive(dc, pc, { confirm, onProgress, onSaved }) {
  const wire = new Wire(dc, pc);
  const hello = await wire.expect('hello', 30000);
  hello.bytes = num(hello.bytes);

  // Room for it?
  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.quota && est.quota - (est.usage || 0) < hello.bytes * 1.05 + 20e6) {
      wire.send({ t: 'decline', reason: 'space' });
      return { declined: true, reason: 'space', bytes: hello.bytes, free: est.quota - (est.usage || 0) };
    }
  } catch { /* can't tell; try anyway */ }

  if (!(await confirm(hello))) {
    wire.send({ t: 'decline', reason: 'no' });
    return { declined: true, reason: 'no' };
  }
  wire.send({ t: 'accept' });
  const manifest = await wire.expect('manifest', 60000);

  const items = await planMerge(manifest);
  wire.send({ t: 'need', keys: items.map((c) => c.key) });

  const total = items.reduce((s, c) => s + num(c.fileSize) + num(c.coverSize), 0);
  let got = 0;
  let added = 0;
  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    const head = await wire.expect('item', 60000);
    if (head.key !== c.key) throw new Error('The transfer got out of step. Try sending again.');
    const take = async (size) => {
      const parts = [];
      let have = 0;
      while (have < size) {
        const chunk = await wire.next(60000);
        if (!(chunk instanceof ArrayBuffer)) throw wire.lost();
        parts.push(chunk);
        have += chunk.byteLength;
        got += chunk.byteLength;
        onProgress?.(got, total, str(c.meta?.name), i, items.length);
      }
      if (have !== size) throw new Error('A file arrived damaged. Try sending again.');
      return parts;
    };
    const coverParts = num(c.coverSize) ? await take(num(c.coverSize)) : null;
    const fileParts = await take(num(c.fileSize));
    const file = new Blob(fileParts, { type: str(c.fileType, 100) });
    const cover = coverParts ? new Blob(coverParts, { type: str(c.coverType, 100) || 'image/jpeg' }) : null;
    let comic;
    try {
      comic = await saveComic({ ...c, added: 0 }, cover, file); // received now = newly added here
    } catch {
      try { wire.send({ t: 'error', message: 'The other device ran out of space.' }); } catch { /* closed */ }
      throw new Error('This device ran out of space. The comics received before this are kept.');
    }
    added++;
    onSaved?.(comic);
  }
  await wire.expect('done', 60000);
  wire.send({ t: 'bye', added });
  await wire.drain();
  return { added, skipped: (manifest.comics || []).length - items.length, from: str(hello.from, 40), title: str(hello.title) };
}

// ---------- shared by receiving and restoring a backup ----------
// Makes the boxes in a manifest (reusing a box with the same name in the same place, so doing it
// twice merges) and returns the issues that aren't here yet, each with the box it goes in.
export async function planMerge(manifest) {
  const allBoxes = await db.all('boxes');
  const target = new Map();
  for (const b of manifest.boxes || []) {
    const parentId = b.parent == null ? ROOT : target.get(b.parent);
    if (parentId == null) continue;
    const name = str(b.name, 200) || 'Box';
    let found = allBoxes.find((x) => x.parentId === parentId && x.name === name);
    if (!found) {
      found = { id: db.uid(), name, parentId, created: Date.now() };
      await db.put('boxes', found);
      allBoxes.push(found);
    }
    target.set(b.key, found.id);
  }
  // Issues already here (same original file name and size in that box) are skipped.
  const items = [];
  const existing = new Map();
  for (const c of manifest.comics || []) {
    const boxId = c.box == null ? ROOT : target.get(c.box);
    if (boxId == null) continue;
    if (!existing.has(boxId)) existing.set(boxId, await db.byIndex('comics', 'boxId', boxId));
    const m = c.meta || {};
    const dup = existing.get(boxId).some((x) => (m.origName
      ? x.origName === m.origName && (!m.origSize || x.origSize === m.origSize)
      : x.name === m.name && x.size === num(c.fileSize)));
    if (!dup) items.push({ ...c, boxId });
  }
  return items;
}

// Saves one planned issue with its file and cover. Throws if the device is out of space.
export async function saveComic(c, cover, file) {
  const meta = c.meta || {};
  const comic = {
    ...pickMeta(meta),
    name: str(meta.name, 300) || 'Comic',
    pages: num(meta.pages),
    lastPage: num(meta.lastPage),
    done: !!meta.done,
    id: db.uid(),
    boxId: c.boxId,
    size: file.size,
    added: num(c.added) || Date.now(),
    cover: cover || null,
  };
  await db.addComic(comic, file);
  return comic;
}
