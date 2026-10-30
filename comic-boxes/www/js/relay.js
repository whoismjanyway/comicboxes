// Pairing two devices with a short code like "K7P 4QX".
//
// Browsers can't find each other on a Wi-Fi network by themselves, so the two devices meet once
// on a free public message relay (ntfy.sh) to swap their connection details (about 1 KB each way).
// Those details are encrypted with a key made from the code, and the place they're posted is also
// made from the code, so the relay only ever sees scrambled text. The comics themselves never go
// through the relay: they go straight between the devices over Wi-Fi (see transfer.js).
//
// If the relay can't be reached (no internet on the Wi-Fi), the screens fall back to scanning
// QR codes both ways, which needs no internet at all.
//
// To use your own ntfy server instead, set localStorage 'cb.relay' to its address.

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L: easy to read and type
const CODE_LENGTH = 6;
const MAX_AGE = 15 * 60; // seconds a code stays usable

export function relayBase() {
  try { return (localStorage.getItem('cb.relay') || 'https://ntfy.sh').replace(/\/+$/, ''); } catch { return 'https://ntfy.sh'; }
}

export function newCode() {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const [b] = crypto.getRandomValues(new Uint8Array(1));
    if (b < 248) out += ALPHABET[b % ALPHABET.length]; // 248 = 8 × 31: no bias
  }
  return out;
}

// Normalises what someone typed. Returns null if it can't be a code.
export function cleanCode(text) {
  const c = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== CODE_LENGTH || [...c].some((ch) => !ALPHABET.includes(ch))) return null;
  return c;
}

export const showCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

// The relay topic and encryption key for a code. Slow on purpose, so codes can't be tried quickly.
const derived = new Map();
async function secrets(code) {
  if (!derived.has(code)) {
    derived.set(code, (async () => {
      const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
      const bits = new Uint8Array(await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('comic-boxes-pairing-1'), iterations: 200000 }, base, 512));
      const topic = `cbx${[...bits.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
      const key = await crypto.subtle.importKey('raw', bits.slice(32, 64), 'AES-GCM', false, ['encrypt', 'decrypt']);
      return { topic, key };
    })());
  }
  return derived.get(code);
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return `${b64(iv)}.${b64(ct)}`;
}

async function unseal(key, text) {
  try {
    const [iv, ct] = String(text).split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

async function withTimeout(ms, fn) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); } finally { clearTimeout(t); }
}

// A plain-text POST, so the browser doesn't need to ask the relay for permission first.
async function publish(topic, body) {
  const res = await withTimeout(8000, (signal) => fetch(`${relayBase()}/${topic}`, { method: 'POST', body, signal, cache: 'no-store' }));
  if (!res.ok) throw new Error(`relay ${res.status}`);
}

async function poll(topic) {
  const res = await withTimeout(8000, (signal) => fetch(`${relayBase()}/${topic}/json?poll=1&since=${MAX_AGE}s`, { signal, cache: 'no-store' }));
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return (await res.text()).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((m) => m && m.event === 'message' && typeof m.message === 'string');
}

// Keeps one connection open and calls onMessage(text) for each new message, reconnecting if it
// drops, until stop() is called.
function listen(topic, since, onMessage) {
  let stopped = false;
  let ctl = null;
  (async () => {
    let tries = 0;
    while (!stopped && tries < 40) {
      ctl = new AbortController();
      try {
        const res = await fetch(`${relayBase()}/${topic}/json?since=${since}`, { signal: ctl.signal, cache: 'no-store' });
        if (!res.ok || !res.body) throw new Error(`relay ${res.status}`);
        tries = 0;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
              const m = JSON.parse(line);
              if (m.event === 'message' && typeof m.message === 'string') { since = m.id || since; onMessage(m.message); }
            } catch { /* not a message line */ }
          }
        }
      } catch { /* dropped or offline: try again */ }
      if (stopped) break;
      tries++;
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return () => { stopped = true; try { ctl?.abort(); } catch { /* fine */ } };
}

// ---------- the two sides ----------
// Sender: posts its connection details under the code and waits for the reply.
// Returns { stop } or throws if the relay can't be reached. onAnswer(details) is called once.
export async function offer(code, details, onAnswer) {
  const { topic, key } = await secrets(code);
  const since = Math.floor(Date.now() / 1000) - 5;
  await publish(`${topic}o`, await seal(key, { kind: 'offer', time: Date.now(), details }));
  let answered = false;
  const stop = listen(`${topic}a`, since, async (text) => {
    if (answered) return;
    const m = await unseal(key, text);
    if (!m || m.kind !== 'answer' || typeof m.details !== 'string') return;
    answered = true;
    stop();
    onAnswer(m.details);
  });
  return { stop };
}

// Receiver: fetches the sender's details for a typed code. Throws a friendly error if there are none.
export async function fetchOffer(code) {
  const { topic, key } = await secrets(code);
  for (let attempt = 0; attempt < 3; attempt++) {
    let msgs;
    try { msgs = await poll(`${topic}o`); } catch {
      throw new Error('Couldn\'t reach the internet to look up that code. If this Wi-Fi has no internet, scan the QR code on the other device instead.');
    }
    for (const m of msgs.reverse()) {
      const o = await unseal(key, m.message);
      if (o && o.kind === 'offer' && typeof o.details === 'string' && Date.now() - o.time < MAX_AGE * 1000) return o.details;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('No device is waiting with that code. Check the code, and that the other device still shows it.');
}

// Receiver: sends its reply. Throws if the relay can't be reached.
export async function answer(code, details) {
  const { topic, key } = await secrets(code);
  await publish(`${topic}a`, await seal(key, { kind: 'answer', time: Date.now(), details }));
}
