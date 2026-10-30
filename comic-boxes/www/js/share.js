// The screens for sending comics to another device and receiving them.
// The network side is in transfer.js; QR codes are in qr.js.
import { qrSvg, openCamera, stopCamera, scanVideo } from './qr.js';
import * as transfer from './transfer.js';

const SAME_WIFI = 'Both devices must be on the same Wi-Fi. Comics go straight from one to the other: never through the internet, and never over mobile data.';

// ui: { el, openSheet, closeSheet, lockSheet, toast, render, formatBytes, plural }
function session(ui) {
  const s = {
    link: null, stream: null, stopScan: null, unwatch: null, wake: null, done: false,
    cleanup() {
      s.done = true;
      s.stopScan?.(); s.stopScan = null;
      stopCamera(s.stream); s.stream = null;
      s.unwatch?.(); s.unwatch = null;
      s.link?.close(); s.link = null;
      s.wake?.release?.().catch?.(() => {}); s.wake = null;
      ui.lockSheet(false);
    },
    show(title, ...nodes) {
      if (s.done) return;
      ui.openSheet([ui.el('h3', {}, title), ...nodes], () => s.cleanup());
    },
    fail(e, title = 'Couldn\'t send') {
      if (s.done) return;
      console.warn(e);
      const msg = e && e.message ? e.message : String(e);
      s.cleanup();
      s.done = false;
      s.show(title, ui.el('p', { class: 'xfer-text' }, msg),
        ui.el('div', { class: 'row' }, ui.el('button', { class: 'btn primary', type: 'button', onclick: () => { s.done = true; ui.closeSheet(); } }, 'OK')));
      s.done = true;
    },
    async keepAwake() {
      try { s.wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed; fine */ }
    },
    watch() {
      s.unwatch = transfer.watchNetwork((msg) => s.fail(new Error(`${msg} Comics received before this are kept.`), 'Stopped'));
    },
  };
  return s;
}

function cancelBtn(ui, s, label = 'Cancel') {
  return ui.el('button', { class: 'btn', type: 'button', onclick: () => { s.cleanup(); ui.closeSheet(); } }, label);
}

// A camera view that reads QR codes, plus a text box for typing or pasting a code instead.
function scanner(ui, s, onCode, hint) {
  const video = ui.el('video', { class: 'xfer-cam', playsinline: '', muted: '', autoplay: '', 'aria-label': 'Camera' });
  video.muted = true;
  const camBox = ui.el('div', { class: 'xfer-cam-wrap' }, video, ui.el('span', { class: 'xfer-aim', 'aria-hidden': 'true' }));
  const camNote = ui.el('p', { class: 'xfer-small' }, hint);
  const input = ui.el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'Paste the code here', 'aria-label': 'Code from the other device' });
  let used = false;
  const take = (text) => {
    if (used || s.done) return;
    used = true;
    s.stopScan?.(); s.stopScan = null;
    Promise.resolve(onCode(String(text).trim())).catch((e) => {
      used = false;
      if (s.done) return;
      camNote.textContent = e.message;
      camNote.classList.add('bad');
      if (s.stream) scanVideo(video, take).then((stop) => { s.stopScan = stop; });
    });
  };
  const textBox = ui.el('details', { class: 'xfer-alt' },
    ui.el('summary', {}, 'No camera? Use a text code'),
    ui.el('form', { class: 'xfer-paste', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) take(input.value); } },
      input, ui.el('button', { class: 'btn', type: 'submit' }, 'Use code')));
  const start = async () => {
    try {
      if (!s.stream) s.stream = await openCamera();
      if (s.done) return;
      video.srcObject = s.stream;
      await video.play().catch(() => {});
      s.stopScan = await scanVideo(video, take);
    } catch (e) {
      camBox.hidden = true;
      camNote.textContent = e.message;
      textBox.open = true;
    }
  };
  return { node: ui.el('div', { class: 'xfer-scan' }, camBox, camNote, textBox), start };
}

// Shows this device's code as a QR, with the same code as text for devices without a camera.
async function codeView(ui, code) {
  const text = ui.el('textarea', { class: 'xfer-code-text', readonly: '', rows: '3', 'aria-label': 'This device\'s code as text', onfocus: (e) => e.target.select() });
  text.value = code;
  const copy = ui.el('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; } catch { text.focus(); text.select(); }
  } }, 'Copy');
  return ui.el('div', { class: 'xfer-code' },
    ui.el('div', { class: 'xfer-qr' }, await qrSvg(code, 'Code for the other device to scan')),
    ui.el('details', { class: 'xfer-alt' }, ui.el('summary', {}, 'Show as text'), text, ui.el('div', { class: 'row' }, copy)));
}

function progressView(ui, label) {
  const fill = ui.el('div', { class: 'progress-fill' });
  const count = ui.el('b', {}, 'Starting…');
  const name = ui.el('span', {}, '');
  const amount = ui.el('p', { class: 'xfer-small' }, '');
  const node = ui.el('div', { class: 'xfer-progress', role: 'status', 'aria-live': 'polite' },
    ui.el('p', { class: 'xfer-text' }, label),
    ui.el('div', { class: 'progress-text' }, count, name),
    ui.el('div', { class: 'progress-track' }, fill), amount);
  let last = 0;
  const update = (got, total, comic, i, n) => {
    const now = Date.now();
    if (now - last < 120 && got < total) return;
    last = now;
    count.textContent = `${i + 1} of ${n}`;
    name.textContent = comic;
    fill.style.width = `${total ? Math.round((got / total) * 100) : 100}%`;
    amount.textContent = `${ui.formatBytes(got)} of ${ui.formatBytes(total)}`;
  };
  return { node, update };
}

function blockedByNetwork(ui, title) {
  const problem = transfer.networkProblem();
  if (!problem) return false;
  ui.openSheet([ui.el('h3', {}, title), ui.el('p', { class: 'xfer-text' }, problem),
    ui.el('div', { class: 'row' }, ui.el('button', { class: 'btn primary', type: 'button', onclick: ui.closeSheet }, 'OK'))]);
  return true;
}

const describe = (ui, n, boxes, bytes) =>
  [ui.plural(n, 'issue', 'issues'), boxes > 1 ? `in ${ui.plural(boxes, 'box', 'boxes')}` : null, ui.formatBytes(bytes)].filter(Boolean).join(', ').replace(/, in /, ' in ');

// ---------- sending ----------
export async function sendFlow(ui, item) {
  if (blockedByNetwork(ui, 'Send to another device')) return;
  const p = await transfer.pack(item);
  if (!p.comics.length) { ui.toast('There are no comics in here to send.'); return; }
  const s = session(ui);
  const what = describe(ui, p.comics.length, p.boxes.length, p.bytes);

  const scan = scanner(ui, s, async (code) => {
    // Make the reply while the camera is still on: phones then share their exact Wi-Fi address.
    s.link = await transfer.makeAnswer(code);
    stopCamera(s.stream); s.stream = null;
    s.watch();
    s.show(`Send "${p.title}"`,
      ui.el('p', { class: 'xfer-text' }, ui.el('b', {}, 'Step 2. '), 'Point the other device\'s camera at this code.'),
      await codeView(ui, s.link.code),
      ui.el('p', { class: 'xfer-small', role: 'status' }, 'Waiting for the other device…'),
      ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
    connect();
  }, 'Point this camera at the code on the other device.');

  s.show(`Send "${p.title}"`,
    ui.el('p', { class: 'xfer-small' }, what),
    ui.el('p', { class: 'xfer-text' }, ui.el('b', {}, 'Step 1. '), 'On the other device open Comic Boxes, tap ', ui.el('b', {}, '+'), ' and choose ', ui.el('b', {}, 'From another device'), '. Then scan the code it shows.'),
    scan.node,
    ui.el('p', { class: 'xfer-small' }, SAME_WIFI),
    ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
  scan.start();

  async function connect() {
    try {
      const dc = await s.link.open();
      const pin = await s.link.pairCode();
      s.show(`Send "${p.title}"`,
        ui.el('p', { class: 'xfer-text' }, 'Connected. Tap ', ui.el('b', {}, 'Accept'), ' on the other device.'),
        ui.el('p', { class: 'xfer-pin', 'aria-label': `Check code ${pin.split('').join(' ')}` }, pin),
        ui.el('p', { class: 'xfer-small' }, 'The other device shows the same number.'),
        ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
      const bar = progressView(ui, `Sending to the other device. Keep both screens on and Comic Boxes open.`);
      let started = false;
      const result = await transfer.send(dc, s.link.pc, p, (...a) => {
        if (!started) {
          started = true;
          ui.lockSheet(true);
          s.keepAwake();
          s.show(`Sending "${p.title}"`, bar.node, ui.el('div', { class: 'row' }, cancelBtn(ui, s, 'Stop')));
        }
        bar.update(...a);
      });
      s.cleanup();
      ui.closeSheet();
      if (result.declined) {
        ui.toast(result.reason === 'space' ? 'The other device doesn\'t have enough space for these comics.' : 'The other device said no.', 5000);
      } else if (!result.added && result.skipped) {
        ui.toast('The other device already has all of these comics.', 4500);
      } else {
        ui.toast(`Sent ${ui.plural(result.added, 'comic', 'comics')}.${result.skipped ? ` ${ui.plural(result.skipped, 'was', 'were')} already there.` : ''}`, 4500);
      }
    } catch (e) {
      s.fail(e);
    }
  }
}

// ---------- receiving ----------
export async function receiveFlow(ui, { isBusy }) {
  if (isBusy()) { ui.toast('Still adding comics. Try again when that finishes.'); return; }
  if (blockedByNetwork(ui, 'Receive comics')) return;
  const s = session(ui);
  s.show('Receive comics', ui.el('p', { class: 'xfer-small', role: 'status' }, 'Getting ready…'), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));

  // Turn the camera on first: it's needed for step 2, and with it on, phones share their exact
  // Wi-Fi address in the code instead of a private name, which connects more reliably.
  try { s.stream = await openCamera(); } catch { /* the scanner below explains and offers text codes */ }
  if (s.done) return;
  try {
    s.link = await transfer.makeOffer();
  } catch (e) { s.fail(e, 'Can\'t receive'); return; }
  if (s.done) return;
  s.watch();

  const scan = scanner(ui, s, async (code) => {
    await s.link.finish(code);
    stopCamera(s.stream); s.stream = null;
    s.show('Receive comics', ui.el('p', { class: 'xfer-small', role: 'status' }, 'Connecting…'), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
    run();
  }, 'Then point this camera at the code that appears on the other device.');

  s.show('Receive comics',
    ui.el('p', { class: 'xfer-text' }, ui.el('b', {}, 'Step 1. '), 'On the other device, tap ', ui.el('b', {}, '⋯'), ' on a box or issue, choose ', ui.el('b', {}, 'Send to another device'), ', and scan this code.'),
    await codeView(ui, s.link.code),
    ui.el('p', { class: 'xfer-text' }, ui.el('b', {}, 'Step 2. '), 'Scan the code that appears on the other device.'),
    scan.node,
    ui.el('p', { class: 'xfer-small' }, SAME_WIFI),
    ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
  scan.start();

  let saved = 0;
  async function run() {
    try {
      const dc = await s.link.open();
      const pin = await s.link.pairCode();
      const bar = progressView(ui, 'Receiving. Keep both screens on and Comic Boxes open.');
      let title = '';
      const result = await transfer.receive(dc, s.link.pc, {
        confirm: (hello) => new Promise((resolve) => {
          title = String(hello.title || 'comics');
          s.show('Receive comics?',
            ui.el('p', { class: 'xfer-text' }, `${String(hello.from || 'Another device')} wants to send you `, ui.el('b', {}, `"${title}"`), '.'),
            ui.el('p', { class: 'xfer-small' }, describe(ui, Number(hello.issues) || 0, Number(hello.boxes) || 0, Number(hello.bytes) || 0)),
            ui.el('p', { class: 'xfer-pin', 'aria-label': `Check code ${pin.split('').join(' ')}` }, pin),
            ui.el('p', { class: 'xfer-small' }, 'Make sure the other device shows the same number. Boxes with the same name are joined, and issues you already have are skipped.'),
            ui.el('div', { class: 'row' },
              ui.el('button', { class: 'btn', type: 'button', onclick: () => resolve(false) }, 'Decline'),
              ui.el('button', { class: 'btn primary', type: 'button', onclick: () => {
                ui.lockSheet(true);
                s.keepAwake();
                s.show(`Receiving "${title}"`, bar.node, ui.el('div', { class: 'row' }, cancelBtn(ui, s, 'Stop')));
                resolve(true);
              } }, 'Accept')));
        }),
        onProgress: bar.update,
        onSaved: () => { saved++; },
      });
      s.cleanup();
      ui.closeSheet();
      await ui.render();
      if (result.declined) {
        ui.toast(result.reason === 'space'
          ? `Not enough space on this device: these comics need ${ui.formatBytes(result.bytes)}.`
          : 'Nothing was received.', 5000);
      } else {
        const bits = [result.added ? `Received ${ui.plural(result.added, 'comic', 'comics')} from ${/^(a|another) /i.test(result.from) ? result.from.toLowerCase() : result.from}.` : `You already had every comic in "${result.title}".`];
        if (result.added && result.skipped) bits.push(`${ui.plural(result.skipped, 'was', 'were')} already here.`);
        ui.toast(bits.join(' '), 5000);
      }
    } catch (e) {
      ui.render();
      s.fail(saved ? new Error(`${e.message} ${ui.plural(saved, 'comic was', 'comics were')} received and kept. Send again to get the rest; ones you have are skipped.`) : e, 'Transfer stopped');
    }
  }
}
