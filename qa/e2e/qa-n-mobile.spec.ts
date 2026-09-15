import { expect, test } from '@playwright/test';

const SHOTS = 'qa-artifacts/claude-N-portal/screens';
test.use({ viewport: { width: 390, height: 844 } });

test('AC-23 the portal is single column at a phone width with no sideways scroll', async ({ page }) => {
  for (const [name, token] of Object.entries({
    'post-show': 'AdmittedOneAAAAAAAAA1x',
    'pre-show': 'UpcomingGGGGGGGGGGG7xx',
  })) {
    await page.goto(`/t/${token}`);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    console.log(name, JSON.stringify(overflow));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    await page.screenshot({ path: `${SHOTS}/AC-23-${name}-390px.png`, fullPage: true });
  }
});
