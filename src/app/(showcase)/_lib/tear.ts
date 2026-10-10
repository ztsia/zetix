/**
 * The Tear mark's geometry (`scripts/brand-assets.mjs`, FULL): a ticket whose perforation is the Z.
 * The upper half is drawn as is; the stub is the same path turned 180° about (32, 32) and moved
 * 1.1 units down and left, which opens the cut between them.
 */
export const TEAR_UPPER =
  'M10 9H54A6 6 0 0 1 60 15V37.6A4.4 4.4 0 0 0 55.94 40.3H25.4L47.4 20.3H8.06A4.4 4.4 0 0 0 4 17.6V15A6 6 0 0 1 10 9Z';
export const TEAR_STUB_TRANSFORM = 'translate(-1.1 1.1) rotate(180 32 32)';

/**
 * The cut, notch to notch through the Z, in the mark's 64-unit box: the centre line of the channel
 * between the two halves (the upper's edge at y 20.3 and 40.3, the stub's at 24.8 and 44.8).
 */
export const TEAR_CUT: ReadonlyArray<readonly [number, number]> = [
  [4, 22.55],
  [42.45, 22.55],
  [20.45, 42.55],
  [60, 42.55],
];

/** Points spaced along the cut, for the perforation the overture punches. */
export function dotsOnCut(spacing: number): Array<[number, number]> {
  const dots: Array<[number, number]> = [];
  for (let i = 0; i < TEAR_CUT.length - 1; i++) {
    const [ax, ay] = TEAR_CUT[i];
    const [bx, by] = TEAR_CUT[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / spacing));
    for (let j = i === 0 ? 0 : 1; j <= steps; j++) {
      dots.push([ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps]);
    }
  }
  return dots;
}
