/**
 * Under the door: the real scanner, for anyone with a phone to hand (docs/local.md §18.2 publishes
 * the ushers' code). Only drawn where the code is configured. The QR opens the scanner's sign-in.
 */
export function UsherCard({
  code,
  ushers,
  path,
  qr,
}: {
  code: string;
  ushers: readonly string[];
  path: string;
  qr: { path: string; size: number } | null;
}) {
  const names = ushers.map((usher) => <b key={usher}>{usher}</b>);
  return (
    <div className="zx-wrap">
      <aside className="zx-usher" aria-label="The real scanner">
        {qr && (
          <svg className="zx-usher__qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={`A QR code that opens ${path}`}>
            <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} rx="1.5" className="zx-usher__qr-ground" />
            <path d={qr.path} />
          </svg>
        )}
        <div>
          <p className="zx-usher__title">Now try the real one, on your phone.</p>
          <p className="zx-usher__body">
            Open <code>{path}</code> and sign in as {names[0]}, {names[1]} or {names[2]} with the code{' '}
            <code>{code}</code>. Anyone you admit stays admitted until the demo resets on Monday.
          </p>
        </div>
      </aside>
    </div>
  );
}
