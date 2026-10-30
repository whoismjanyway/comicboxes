// QR codes for pairing two devices: drawing them and reading them with the camera.
// Both libraries are bundled in vendor/qr and loaded only when needed, so they work offline.

const loaded = new Map();
function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => { loaded.delete(src); reject(new Error(`Couldn't load ${src}`)); };
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

// An <svg> QR code. Always black on white, whatever the theme, so every camera can read it.
export async function qrSvg(text, label = 'Pairing code') {
  await loadScript('vendor/qr/qrcode.js');
  const qr = window.qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const pad = 4;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  }
  const size = n + pad * 2;
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `0 0 ${size} ${size}`);
  s.setAttribute('class', 'qr');
  s.setAttribute('role', 'img');
  s.setAttribute('aria-label', label);
  s.setAttribute('shape-rendering', 'crispEdges');
  s.innerHTML = `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000" stroke="none"/>`;
  return s;
}

// Opens the back camera (any camera on laptops). Throws a friendly error if it can't.
export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can\'t use the camera.');
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error('Camera access is off. Allow the camera for Comic Boxes in your browser or phone settings, or use a text code.');
    }
    throw new Error('No camera found. Use a text code instead.');
  }
}

export function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

// Watches a playing <video> for QR codes. Calls onCode(text) for each code it sees
// until the returned stop() is called. Uses the phone's built-in reader when there is one.
export async function scanVideo(video, onCode) {
  let stopped = false;
  let detector = null;
  try {
    if ('BarcodeDetector' in window && (await window.BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
      detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    }
  } catch { detector = null; }
  if (!detector) await loadScript('vendor/qr/jsQR.js');

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const tick = async () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        let text = null;
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        } else {
          const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
        }
        if (text && !stopped) onCode(text);
      }
    } catch { /* a bad frame; try the next one */ }
    if (!stopped) setTimeout(tick, 160);
  };
  tick();
  return () => { stopped = true; };
}
