/**
 * QA only — decode a QR out of an SVG, the way a phone camera would.
 *
 * The point is independence: the page draws its symbol with `qrcode`, so
 * re-encoding the expected payload with the same library and comparing markup
 * would prove only that the library is deterministic. This rasterises what the
 * page actually shipped and reads it back with `@zxing/library` — the decoder
 * the door's own scanner uses — so a wrong payload is caught rather than
 * restated.
 *
 *   node qa/support/decode-qr.mjs <file.svg>
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

// `sharp` is a transitive dependency here rather than a hoisted one, so it is
// resolved from the store by path. QA-only; nothing in `src/` does this.
const require_ = createRequire(import.meta.url);
const sharp = require_(
  new URL(
    '../../node_modules/.pnpm/sharp@0.35.4_@types+node@20.19.43/node_modules/sharp',
    import.meta.url,
  ).pathname,
);
const { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } =
  require_('@zxing/library');

const file = process.argv[2];
const svg = fs.readFileSync(file);

const SIZE = 600;
const { data, info } = await sharp(svg, { density: 300 })
  .resize(SIZE, SIZE, { fit: 'contain', background: '#ffffff' })
  .flatten({ background: '#ffffff' })
  .raw()
  .toBuffer({ resolveWithObject: true });

const px = new Int32Array(info.width * info.height);
for (let i = 0; i < px.length; i++) {
  const o = i * info.channels;
  px[i] = (0xff << 24) | (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
}

const source = new RGBLuminanceSource(px, info.width, info.height);
const bitmap = new BinaryBitmap(new HybridBinarizer(source));
const result = new QRCodeReader().decode(bitmap);
process.stdout.write(result.getText());
