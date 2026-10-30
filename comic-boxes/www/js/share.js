// The screens for sending comics to another device and receiving them.
// The network side is in transfer.js; QR codes are in qr.js.
import { qrSvg, openCamera, stopCamera, scanVideo } from './qr.js';
import * as transfer from './transfer.js';
import * as relay from './relay.js';

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
function scanner(ui, s, onCode, hint, withText = true) {
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
  return { node: ui.el('div', { class: 'xfer-scan' }, camBox, camNote, withText && textBox), start, take };
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

// ---------- the guide ----------
// The three moments both devices go through, shown at the top of each screen.
const STEPS = ['Code', 'Connect', 'Accept'];
function stepper(ui, at) {
  return ui.el('ol', { class: 'xfer-steps', 'aria-label': `Step ${at} of 3` },
    STEPS.map((label, i) => ui.el('li', { class: i + 1 < at ? 'done' : i + 1 === at ? 'now' : '', 'aria-current': i + 1 === at ? 'step' : false },
      ui.el('span', { class: 'n' }, String(i + 1)), ui.el('span', { class: 'l' }, label))));
}

// Two devices side by side with the comics moving between them over Wi-Fi.
function guidePicture(ui) {
  const box = ui.el('div', { class: 'xfer-pic', 'aria-hidden': 'true' });
  box.innerHTML = `<svg viewBox="0 0 260 96" class="xfer-pic-svg">
    <rect x="8" y="6" width="54" height="84" rx="9" class="ph"/><rect x="15" y="16" width="40" height="58" rx="3" class="scr"/>
    <rect x="22" y="24" width="26" height="36" rx="2" class="cv"/><rect x="22" y="64" width="26" height="4" rx="2" class="ln"/>
    <rect x="198" y="6" width="54" height="84" rx="9" class="ph"/><rect x="205" y="16" width="40" height="58" rx="3" class="scr"/>
    <rect x="212" y="24" width="26" height="36" rx="2" class="cv dim"/><rect x="212" y="64" width="26" height="4" rx="2" class="ln"/>
    <path d="M80 48h96" class="ar"/><path d="M168 40l10 8-10 8" class="ar ah"/>
    <path d="M114 24a22 22 0 0 1 32 0M119 30a14 14 0 0 1 22 0" class="wf"/><circle cx="130" cy="36" r="2.6" class="wfd"/>
  </svg>`;
  return box;
}

// The how-to, used on its own (Settings) and folded inside the send and receive screens.
export function guideSteps(ui) {
  const item = (n, ...text) => ui.el('li', {}, ui.el('span', { class: 'n' }, String(n)), ui.el('p', {}, ...text));
  return ui.el('div', { class: 'xfer-guide' },
    guidePicture(ui),
    ui.el('ol', {},
      item(1, ui.el('b', {}, 'Same Wi-Fi. '), 'Put both devices on the same Wi-Fi. A phone\'s hotspot works too.'),
      item(2, ui.el('b', {}, 'On the device with the comics, '), 'tap ', ui.el('b', {}, '⋯'), ' on a box or issue and choose ', ui.el('b', {}, 'Send to another device'), '. A short code and a QR code appear.'),
      item(3, ui.el('b', {}, 'On the other device, '), 'tap ', ui.el('b', {}, '+'), ', choose ', ui.el('b', {}, 'Receive comics'), ' and type the code, or scan the QR code. The two connect by themselves.'),
      item(4, ui.el('b', {}, 'Accept. '), 'Both screens show the same 4-digit number. Tap ', ui.el('b', {}, 'Accept'), ' on the receiving device and keep both screens on until it finishes.')),
    ui.el('p', { class: 'xfer-small' }, 'The comics go straight from one device to the other over Wi-Fi, never over mobile data. The short code uses the internet for a moment to introduce the two devices (about 2 KB, scrambled). No internet on this Wi-Fi? Scan the QR code, then tap ', ui.el('b', {}, 'Scan its code'), ' on the sending device and scan the code shown back.'),
    ui.el('p', { class: 'xfer-small' }, 'Issues the other device already has are skipped, so if a transfer stops part way, just send again.'));
}

export function showGuide(ui) {
  ui.openSheet([ui.el('h3', {}, 'Send comics to another device'), guideSteps(ui),
    ui.el('div', { class: 'row' }, ui.el('button', { class: 'btn primary', type: 'button', onclick: ui.closeSheet }, 'Got it'))]);
}

const helpFold = (ui) => ui.el('details', { class: 'xfer-alt xfer-help' }, ui.el('summary', {}, 'How does this work?'), guideSteps(ui));
const status = (ui, text) => ui.el('p', { class: 'xfer-small xfer-status', role: 'status' }, text);

// What the QR code holds: the full connection details (so it works with no internet), plus the
// short code when the relay was reached (so scanning it connects without a second scan).
const qrText = (details, code) => (code ? `${details}#${code}` : details);
function readQr(text) {
  const [details, code] = String(text).trim().split('#');
  return { details, code: code ? relay.cleanCode(code) : null };
}

// ---------- sending ----------
// The device with the comics goes first: it shows a short code and a QR code, then waits.
export async function sendFlow(ui, item) {
  if (blockedByNetwork(ui, 'Send to another device')) return;
  const p = await transfer.pack(item);
  if (!p.comics.length) { ui.toast('There are no comics in here to send.'); return; }
  const s = session(ui);
  const title = `Send "${p.title}"`;
  const what = describe(ui, p.comics.length, p.boxes.length, p.bytes);
  s.show(title, stepper(ui, 1), status(ui, 'Getting ready…'), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));

  try { s.link = await transfer.makeOffer(); } catch (e) { s.fail(e); return; }
  if (s.done) return;
  s.watch();

  let answered = false;
  const finish = async (reply) => {
    s.stopRelay?.();
    try {
      await s.link.finish(reply);
    } catch (e) { s.fail(e); return; }
    stopCamera(s.stream); s.stream = null;
    s.show(title, stepper(ui, 2), status(ui, 'Connecting…'), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
    connect();
  };

  // Post the details under a fresh short code. Without internet, only the QR codes work.
  const code = relay.newCode();
  let usedCode = false;
  try {
    const r = await relay.offer(code, s.link.code, (reply) => {
      if (s.done || answered) return;
      answered = true;
      finish(reply);
    });
    s.stopRelay = r.stop;
    usedCode = true;
  } catch { /* offline: QR codes only */ }
  if (s.done) { s.stopRelay?.(); return; }
  const cleanupBase = s.cleanup;
  s.cleanup = () => { s.stopRelay?.(); cleanupBase(); };

  // Offline fallback: scan the code the other device shows back.
  const scan = scanner(ui, s, async (text) => {
    if (answered) return;
    transfer.readCode(text, 'answer'); // throws a helpful message if it's the wrong kind of code
    answered = true;
    await finish(text);
  }, 'Hold it steady for a moment.');
  let scanning = false;
  const theirs = ui.el('div', { hidden: '' },
    ui.el('p', { class: 'xfer-text' }, 'Point this camera at the code on the other device.'),
    scan.node,
    ui.el('button', { class: 'btn wide', type: 'button', onclick: () => flip(false) }, 'Show my code again'));
  const mine = ui.el('div', {},
    usedCode
      ? ui.el('div', {},
        ui.el('p', { class: 'xfer-text' }, 'On the other device, tap ', ui.el('b', {}, '+'), ' and choose ', ui.el('b', {}, 'Receive comics'), '. Type this code:'),
        ui.el('p', { class: 'xfer-bigcode', 'aria-label': `Code ${code.split('').join(' ')}` }, relay.showCode(code)),
        ui.el('p', { class: 'xfer-small center' }, 'or scan this QR code:'))
      : ui.el('p', { class: 'xfer-text' }, 'This Wi-Fi has no internet, so use QR codes. On the other device, tap ', ui.el('b', {}, '+'), ', choose ', ui.el('b', {}, 'Receive comics'), ' and scan this code.'),
    await codeView(ui, qrText(s.link.code, usedCode ? code : null)),
    usedCode
      ? status(ui, 'Waiting for the other device…')
      : ui.el('button', { class: 'btn primary wide', type: 'button', onclick: () => flip(true) }, 'It shows a code. Scan its code'),
    usedCode && ui.el('details', { class: 'xfer-alt' }, ui.el('summary', {}, 'The other device shows a QR code instead?'),
      ui.el('p', { class: 'xfer-small' }, 'That happens when it has no internet. Scan its code to finish connecting.'),
      ui.el('button', { class: 'btn wide', type: 'button', onclick: () => flip(true) }, 'Scan its code')));
  const steps = ui.el('div', {}, stepper(ui, 1));
  const flip = (toScan) => {
    mine.hidden = toScan;
    theirs.hidden = !toScan;
    steps.replaceChildren(stepper(ui, toScan ? 2 : 1));
    if (toScan && !scanning) { scanning = true; scan.start(); }
  };
  s.show(title, steps, ui.el('p', { class: 'xfer-small' }, what), mine, theirs,
    ui.el('p', { class: 'xfer-small' }, SAME_WIFI), helpFold(ui), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));

  async function connect() {
    try {
      const dc = await s.link.open();
      const pin = await s.link.pairCode();
      s.show(title, stepper(ui, 3),
        ui.el('p', { class: 'xfer-text' }, 'Connected. Check that the other device shows this number, and tap ', ui.el('b', {}, 'Accept'), ' there.'),
        ui.el('p', { class: 'xfer-pin', 'aria-label': `Check number ${pin.split('').join(' ')}` }, pin),
        ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
      const bar = progressView(ui, 'Sending. Keep both screens on and Comic Boxes open.');
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
// Type the sender's short code (or scan its QR code) and the two connect by themselves.
export async function receiveFlow(ui, { isBusy }) {
  if (isBusy()) { ui.toast('Still adding comics. Try again when that finishes.'); return; }
  if (blockedByNetwork(ui, 'Receive comics')) return;
  const s = session(ui);
  const title = 'Receive comics';
  let busyNow = false;

  // Shared by typing and scanning. `details` is the sender's connection details; `code` is set
  // when they can also be answered through the relay.
  const answerWith = async (details, code) => {
    s.link = await transfer.makeAnswer(details);
    stopCamera(s.stream); s.stream = null;
    s.stopScan?.(); s.stopScan = null;
    s.watch();
    if (code) {
      try {
        await relay.answer(code, s.link.code);
        s.show(title, stepper(ui, 2), status(ui, 'Connecting…'), ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
        run();
        return;
      } catch { /* no internet: show a QR code for the sender to scan instead */ }
    }
    s.show(title, stepper(ui, 2),
      ui.el('p', { class: 'xfer-text' }, 'This Wi-Fi has no internet, so finish with a QR code: on the sending device, tap ', ui.el('b', {}, 'Scan its code'), ' and point it at this code.'),
      await codeView(ui, s.link.code),
      status(ui, 'Waiting for the other device…'),
      ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
    run();
  };

  const note = ui.el('p', { class: 'xfer-small', role: 'status' }, '');
  const input = ui.el('input', {
    class: 'xfer-code-input', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
    maxlength: '400', placeholder: 'K7P 4QX', 'aria-label': 'Code shown on the other device', enterkeyhint: 'go',
  });
  const go = ui.el('button', { class: 'btn primary', type: 'submit' }, 'Connect');
  const useTyped = async () => {
    if (busyNow || s.done) return;
    const typed = input.value.trim();
    note.classList.remove('bad');
    // A long pasted code is the full details (works with no internet).
    const long = typed.startsWith('CB1|') ? readQr(typed) : null;
    const code = long ? null : relay.cleanCode(typed);
    if (!long && !code) {
      note.textContent = 'Codes are 6 letters and numbers, like K7P 4QX.';
      note.classList.add('bad');
      return;
    }
    busyNow = true;
    go.disabled = true;
    try {
      if (long) { await answerWith(long.details, long.code); return; }
      note.textContent = 'Looking for the other device…';
      if (!(await transfer.hasWifiAddress())) throw new Error('This device isn\'t on a Wi-Fi network. Connect both devices to the same Wi-Fi.');
      const details = await relay.fetchOffer(code);
      if (s.done) return;
      await answerWith(details, code);
    } catch (e) {
      if (s.done) return;
      busyNow = false;
      go.disabled = false;
      note.textContent = e.message;
      note.classList.add('bad');
    }
  };
  input.addEventListener('input', () => {
    // Show "K7P 4QX" as it's typed.
    const raw = input.value;
    if (raw.length <= 8 && !raw.startsWith('CB')) {
      const c = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 6);
      const shown = c.length > 3 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
      if (shown !== raw) input.value = shown;
      if (c.length === 6) useTyped();
    }
  });

  const scan = scanner(ui, s, async (text) => {
    if (busyNow) return;
    const { details, code } = readQr(text);
    transfer.readCode(details, 'offer'); // throws a helpful message for the wrong kind of code
    busyNow = true;
    try { await answerWith(details, code); } catch (e) { busyNow = false; throw e; }
  }, 'Hold it steady for a moment.', false);
  const scanBox = ui.el('div', { hidden: '' }, scan.node);
  const scanBtn = ui.el('button', { class: 'btn wide', type: 'button', onclick: () => {
    scanBtn.hidden = true;
    scanBox.hidden = false;
    scan.start();
  } }, 'Scan the QR code instead');

  s.show(title, stepper(ui, 1),
    ui.el('p', { class: 'xfer-text' }, 'On the device with the comics, tap ', ui.el('b', {}, '⋯'), ' on a box or issue and choose ', ui.el('b', {}, 'Send to another device'), '. Type the code it shows:'),
    ui.el('form', { class: 'xfer-code-form', onsubmit: (e) => { e.preventDefault(); useTyped(); } }, input, go),
    note,
    scanBtn, scanBox,
    ui.el('p', { class: 'xfer-small' }, SAME_WIFI),
    helpFold(ui),
    ui.el('div', { class: 'row' }, cancelBtn(ui, s)));
  setTimeout(() => input.focus(), 80);

  let saved = 0;
  async function run() {
    try {
      const dc = await s.link.open();
      const pin = await s.link.pairCode();
      const bar = progressView(ui, 'Receiving. Keep both screens on and Comic Boxes open.');
      let what = '';
      const result = await transfer.receive(dc, s.link.pc, {
        confirm: (hello) => new Promise((resolve) => {
          what = String(hello.title || 'comics');
          s.show('Receive comics?', stepper(ui, 3),
            ui.el('p', { class: 'xfer-text' }, `${String(hello.from || 'Another device')} wants to send you `, ui.el('b', {}, `"${what}"`), '.'),
            ui.el('p', { class: 'xfer-small' }, describe(ui, Number(hello.issues) || 0, Number(hello.boxes) || 0, Number(hello.bytes) || 0)),
            ui.el('p', { class: 'xfer-pin', 'aria-label': `Check number ${pin.split('').join(' ')}` }, pin),
            ui.el('p', { class: 'xfer-small' }, 'Make sure the other device shows the same number. Boxes with the same name are joined, and issues you already have are skipped.'),
            ui.el('div', { class: 'row' },
              ui.el('button', { class: 'btn', type: 'button', onclick: () => resolve(false) }, 'Decline'),
              ui.el('button', { class: 'btn primary', type: 'button', onclick: () => {
                ui.lockSheet(true);
                s.keepAwake();
                s.show(`Receiving "${what}"`, bar.node, ui.el('div', { class: 'row' }, cancelBtn(ui, s, 'Stop')));
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
