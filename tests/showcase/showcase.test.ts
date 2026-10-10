import { afterEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config';
import { isShowcase } from '@/app/(showcase)/_lib/flag';
import { qrPath } from '@/app/(showcase)/_lib/qr';

// `notFound()` works by throwing, so it is mocked into a recognisable error, as in
// `tests/auth/guards.test.ts`.
class NotFoundSignal extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFoundSignal('notFound');
  },
}));

const { default: ShowcasePage } = await import('@/app/(showcase)/showcase/page');
const {
  default: PhoneScreenPage,
  generateStaticParams,
  dynamicParams,
} = await import('@/app/(showcase)/showcase/phone/[screen]/page');

/**
 * The showcase switch (spec/v3.md §31). Production must keep its placeholder at `/` whatever the
 * environment looks like, and the demo deployment must get the landing page. The two places that
 * read `SHOWCASE` are the page's own guard and the rewrite that serves it at `/`: both are held to
 * the same rule here, blank reads as unset, as in `@/lib/env`.
 */
describe('SHOWCASE', () => {
  const original = process.env.SHOWCASE;
  afterEach(() => {
    if (original === undefined) delete process.env.SHOWCASE;
    else process.env.SHOWCASE = original;
  });

  it.each([
    [undefined, false],
    ['', false],
    ['   ', false],
    ['1', true],
  ])('reads %j as %s', (value, expected) => {
    expect(isShowcase(value === undefined ? {} : { SHOWCASE: value })).toBe(expected);
  });

  async function rootRewrites() {
    const rewrites = await nextConfig.rewrites!();
    return Array.isArray(rewrites) ? rewrites : (rewrites.beforeFiles ?? []);
  }

  it('leaves `/` alone where it is unset or blank, so production keeps its placeholder', async () => {
    delete process.env.SHOWCASE;
    expect(await rootRewrites()).toEqual([]);
    for (const blank of ['', '   ']) {
      process.env.SHOWCASE = blank;
      expect(await rootRewrites()).toEqual([]);
    }
  });

  it('serves the landing page at `/`, before the placeholder, where it is set', async () => {
    process.env.SHOWCASE = '1';
    expect(await rootRewrites()).toEqual([{ source: '/', destination: '/showcase' }]);
  });

  // The rewrite only decides what `/` shows. Each route is still reachable at its own path, so
  // each has to refuse on its own.
  const phone = (screen: string) => PhoneScreenPage({ params: Promise.resolve({ screen }) });

  it('is a 404 at its own paths where it is unset or blank: the page, and each phone', async () => {
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.SHOWCASE;
      else process.env.SHOWCASE = value;
      expect(() => ShowcasePage()).toThrow(NotFoundSignal);
      await expect(phone('ticket')).rejects.toThrow(NotFoundSignal);
      await expect(phone('after')).rejects.toThrow(NotFoundSignal);
    }
  });

  it('serves the page and the two phones where it is set, and no third screen', async () => {
    process.env.SHOWCASE = '1';
    expect(() => ShowcasePage()).not.toThrow();
    expect((await phone('ticket')).props.screen).toBe('ticket');
    expect((await phone('after')).props.screen).toBe('after');
    await expect(phone('admin')).rejects.toThrow(NotFoundSignal);
    // And the router never asks for one: only the two are built, and nothing else is rendered.
    expect(generateStaticParams()).toEqual([{ screen: 'ticket' }, { screen: 'after' }]);
    expect(dynamicParams).toBe(false);
  });
});

describe('qrPath', () => {
  it('draws a whole QR code as one path in module units', () => {
    const { path, size } = qrPath('ORC-SDM1');
    // Version 1 is 21 modules; each version adds 4.
    expect((size - 21) % 4).toBe(0);
    expect(path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    // Every run is closed, and none reaches past the edge.
    for (const [, x, , run] of path.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
      expect(Number(x) + Number(run)).toBeLessThanOrEqual(size);
    }
  });

  it('is deterministic, so the server and every build draw the same ticket', () => {
    expect(qrPath('ORC-SDM1')).toEqual(qrPath('ORC-SDM1'));
  });
});
