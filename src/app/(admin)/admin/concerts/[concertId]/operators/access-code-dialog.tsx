'use client';

import { useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import type { IssuedCode } from './form-state';

/**
 * The one time anybody sees an access code (spec/admin.md §14.3).
 *
 * The code exists in this component's props and nowhere else that survives the
 * dialog closing: it is a Supabase password, so the database holds only a hash,
 * and it is deliberately kept out of `audit_log`. That makes this dialog the
 * single point of failure for handing a usher their credential, so it is built
 * to be hard to close by accident — no click-outside, no Escape, and an explicit
 * acknowledgement button rather than a bare ✕.
 *
 * The copy button is the path that actually gets used; the code is also readable
 * in a monospace field for the admin who is reading it down a phone line.
 */
export function AccessCodeDialog({
  issued,
  onClose,
}: {
  issued: IssuedCode | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.accessCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A refused clipboard permission is not a failure worth interrupting for:
      // the code is on screen and selectable, which is the fallback.
    }
  }

  return (
    <Dialog
      open={issued !== null}
      // Closing this destroys the only copy of the code, so a stray click on the
      // backdrop or a reflexive Escape must not do it. Every close request is
      // ignored — the acknowledgement button below is the only way out, and
      // driving it from `open` rather than from Base UI's dismissal props means
      // it does not depend on which of them this build exposes.
      onOpenChange={() => {}}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Access code for {issued?.displayName}</DialogTitle>
          <DialogDescription>
            Pass this to the usher along with their display name. They enter both at{' '}
            <code className="text-foreground">/scan</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="my-2 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="issued-access-code">Access code</Label>
            <InputGroup>
              <InputGroupInput
                id="issued-access-code"
                readOnly
                value={issued?.accessCode ?? ''}
                className="font-mono text-base tracking-widest"
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label="Copy access code"
                  onClick={copy}
                >
                  {copied ? <Check /> : <Copy />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <Alert>
            <TriangleAlert />
            <AlertTitle>This is shown once</AlertTitle>
            <AlertDescription>
              It is stored only as a hash, so it cannot be looked up again. If it is lost, issue a
              new code from the operator&apos;s row — that replaces the old one.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button onClick={() => { setCopied(false); onClose(); }}>I have saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
