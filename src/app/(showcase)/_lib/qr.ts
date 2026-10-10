import QRCode from 'qrcode';

/**
 * A QR code as one SVG path in module units, drawn on the server: each run of dark modules in a row
 * is a single rectangle, so a code is a few hundred bytes and no client library.
 */
export function qrPath(text: string): { path: string; size: number } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size, data } = modules;
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && data[y * size + x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  return { path, size };
}
