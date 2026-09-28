'use client';

import * as React from 'react';
import { Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { partyUpdateLinkAction } from './actions';

/**
 * Copies the party's own update link (spec/v3.md §25.6) — for an admin to
 * pass on by hand. The link is the party's credential, so it is fetched on
 * demand rather than drawn into the page.
 */
export function UpdateLinkButton({ concertId, registrationId }: { concertId: number; registrationId: number }) {
  const [state, setState] = React.useState<'idle' | 'busy' | 'copied' | string>('idle');
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={state === 'busy'}
        onClick={async () => {
          setState('busy');
          const result = await partyUpdateLinkAction(concertId, registrationId);
          if (!result.ok) return setState(result.error);
          try {
            await navigator.clipboard.writeText(result.url);
            setState('copied');
          } catch {
            // Clipboard refused: show it so it can be copied by hand.
            setState(result.url);
          }
        }}
      >
        {state === 'copied' ? <Check data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}
        {state === 'copied' ? 'Copied' : 'Copy link'}
      </Button>
      {state !== 'idle' && state !== 'busy' && state !== 'copied' ? (
        <span className="text-muted-foreground break-all text-xs">{state}</span>
      ) : null}
    </span>
  );
}
