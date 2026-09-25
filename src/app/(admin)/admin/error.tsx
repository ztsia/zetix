'use client';

import { EyeIcon, TriangleAlertIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { READ_ONLY_DIGEST, READ_ONLY_MESSAGE } from '@/lib/auth/read-only';

/**
 * The console's error boundary, inside the shell so the sidebar survives it.
 *
 * It exists for one case above all: a **viewer** whose click reached a Server
 * Action only an admin may run (spec/v3.md §28). The console hides those
 * controls from a viewer, but a stale tab or a control a screen forgot to hide
 * still gets here, and "something went wrong" would read as a bug. The refusal
 * carries {@link READ_ONLY_DIGEST}, which survives a production build's message
 * redaction, so it can be told apart from a genuine failure.
 */
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const readOnly = error.digest === READ_ONLY_DIGEST;

  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">{readOnly ? <EyeIcon /> : <TriangleAlertIcon />}</EmptyMedia>
        <EmptyTitle>{readOnly ? 'Read-only account' : 'Something went wrong'}</EmptyTitle>
        <EmptyDescription>
          {readOnly
            ? READ_ONLY_MESSAGE
            : 'This screen hit an error. Try again; if it keeps happening, reload the page.'}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={reset}>
          {readOnly ? 'Back to the screen' : 'Try again'}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
