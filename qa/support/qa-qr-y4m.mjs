/**
 * QA only — render a QR payload as a Y4M video file, so Chromium's fake camera
 * can present a real QR code to the real `@zxing/browser` reader.
 *
 * The scanner's whole decode path (camera -> zxing -> extractQrToken -> hash ->
 * evaluate -> enqueue -> POST) is otherwise unreachable from a headless test,
 * and the branch's own e2e never exercises it.
 *
 *   node qa/support/qa-qr-y4m.mjs "<payload>" /tmp/out.y4m
 */
import fs from 'node:fs';
import QRCode from 'qrcode';

const [, , payload, out] = process.argv;
if (!payload || !out) {
  console.error('usage: qa-qr-y4m.mjs <payload> <out.y4m>');
  process.exit(1);
}

const W = 640;
const H = 480;
const FRAMES = 60;

const qr = QRCode.create(payload, { errorCorrectionLevel: 'M' });
const size = qr.modules.size;
const data = qr.modules.data;

// Scale the QR to fill most of the frame, centred on white.
const scale = Math.floor(Math.min(W, H) / (size + 8));
const quiet = 4 * scale;
const drawn = size * scale;
const originX = Math.floor((W - drawn) / 2);
const originY = Math.floor((H - drawn) / 2);

const y = Buffer.alloc(W * H, 235); // white paper
for (let row = 0; row < size; row++) {
  for (let col = 0; col < size; col++) {
    if (!data[row * size + col]) continue;
    for (let dy = 0; dy < scale; dy++) {
      const py = originY + row * scale + dy;
      if (py < 0 || py >= H) continue;
      const base = py * W + originX + col * scale;
      y.fill(16, base, base + scale); // black ink
    }
  }
}
void quiet;

const u = Buffer.alloc((W / 2) * (H / 2), 128);
const v = Buffer.alloc((W / 2) * (H / 2), 128);

const chunks = [Buffer.from(`YUV4MPEG2 W${W} H${H} F25:1 Ip A1:1 C420mpeg2\n`)];
for (let f = 0; f < FRAMES; f++) {
  chunks.push(Buffer.from('FRAME\n'), y, u, v);
}
fs.writeFileSync(out, Buffer.concat(chunks));
console.log(`${out} ${size}x${size} modules, scale ${scale}`);
