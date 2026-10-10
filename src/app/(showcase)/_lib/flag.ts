/**
 * Whether `/` is the Zetix landing page (spec/v3.md §31). Only the demo deployment sets
 * `SHOWCASE`; production and every self-hosted copy keep the plain page.
 *
 * Blank reads as unset, as everywhere else (`@/lib/env`). The page is static, so this is the value
 * the build saw: changing it on Vercel takes a redeploy.
 */
export function isShowcase(source: Record<string, string | undefined> = process.env): boolean {
  return Boolean(source.SHOWCASE?.trim());
}
