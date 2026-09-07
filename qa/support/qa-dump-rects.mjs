import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
const pdf = readFileSync(process.argv[2]);
const text = pdf.toString('latin1');
const re = /stream\r?\n/g; let m; let content = '';
while ((m = re.exec(text))) {
  const start = m.index + m[0].length; const end = text.indexOf('endstream', start);
  let body = pdf.subarray(start, end);
  try { body = inflateSync(body); } catch {}
  const s = body.toString('latin1');
  if (s.includes(' cm') || s.includes(' Tm')) content += s + '\n';
}
const i = content.indexOf(' cm');
console.log(JSON.stringify(content.slice(Math.max(0, i - 200), i + 400)));
