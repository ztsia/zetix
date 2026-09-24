'use client';

import { useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * Google Forms' "Copy responder link".
 *
 * The address is built from the page's own origin, which is the deployment the
 * admin is signed in to — the same host the link will be served from — rather
 * than from a configured URL that could name a deployment that has since gone.
 *
 * **It copies a draft's link too, and says so.** A committee member often wants
 * the link in hand before the form opens, to put on a poster; the tooltip is
 * what stops them believing it already works.
 */
export function CopyLinkButton({ slug, live }: { slug: string; live: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/f/${slug}`);
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
