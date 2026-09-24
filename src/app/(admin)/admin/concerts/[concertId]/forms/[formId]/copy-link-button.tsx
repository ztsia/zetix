'use client';

import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Google Forms' "Copy responder link".
 *
 * **Built from `APP_URL`**, the production alias, never from the page's own
 * origin (`CLAUDE.md`): an admin working on a per-deployment Vercel hostname
 * would otherwise copy a link that dies within days, onto a poster. The origin
 * is only the fallback where `APP_URL` is unset, which is a local machine.
 *
 * **It copies a draft's link too, and says so.** A committee member often wants
 * the link in hand before the form opens, to put on a poster; the tooltip is
 * what stops them believing it already works.
 */
export function CopyLinkButton({
  slug,
  live,
  appUrl,
}: {
  slug: string;
  live: boolean;
  /** `APP_URL`, read on the server and handed down. */
  appUrl: string | null;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      const base = (appUrl ?? window.location.origin).replace(/\/$/, '');
      await navigator.clipboard.writeText(`${base}/f/${slug}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, a denied
      // permission). The link is printed under the title either way.
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Copy responder link" onClick={copy} />
        }
      >
        {copied ? <Check /> : <Link2 />}
      </TooltipTrigger>
      <TooltipContent>
        {copied
          ? 'Copied'
          : live
            ? 'Copy responder link'
            : 'Copy responder link — it opens once the form is published'}
      </TooltipContent>
    </Tooltip>
  );
}
