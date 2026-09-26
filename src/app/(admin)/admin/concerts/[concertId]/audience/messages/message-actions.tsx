'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Ban, MailCheck, MoreHorizontal, PencilLine, Repeat, RotateCw, Trash2, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { useCanEdit } from '@/components/auth/role';
import { MESSAGE_EXITS, type MessageExit, type MessageStatus } from '@/lib/delivery/message-filter';
import { useRunCommand } from '../command-host';
import { editMessageAction, fixAddressAction, loadMessageAction } from './actions';

/**
 * A message's exits (spec/v3.md §24.4), as one menu: the same list on the
 * record's Conversation tab and in the Messages view, read from
 * `MESSAGE_EXITS`, so a status offers the same exits wherever it is seen.
 *
 * Retry, Cancel, Delete and Resend are commands, previewed and reported by the
 * page's command host like any other. Edit and Fix address need the admin's
 * words first, so they open their own small dialog and then run.
 */

const EXIT: Record<MessageExit, { label: string; icon: typeof Ban; command?: string; destructive?: boolean }> = {
  retry: { label: 'Retry', icon: RotateCw, command: 'messages.retry' },
  'fix-address': { label: 'Fix address…', icon: MailCheck },
  edit: { label: 'Edit…', icon: PencilLine },
  resend: { label: 'Resend', icon: Repeat, command: 'messages.resend' },
  cancel: { label: 'Cancel', icon: Ban, command: 'messages.cancel' },
  delete: { label: 'Delete', icon: Trash2, command: 'messages.delete', destructive: true },
};

export function MessageActions({
  concertId,
  messageId,
  status,
  toParty,
  onDone,
}: {
  concertId: number;
  messageId: number;
  status: MessageStatus;
  /** Addressed to a party (not a player), so its address is the party's to fix. */
  toParty: boolean;
  onDone?: () => void;
}) {
  const canEdit = useCanEdit();
  const runCommand = useRunCommand();
  const [open, setOpen] = React.useState<'edit' | 'fix-address' | null>(null);
  const exits = MESSAGE_EXITS[status].filter((exit) => exit !== 'fix-address' || toParty);
  if (!canEdit || exits.length === 0) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="icon-sm" variant="ghost" aria-label="Message actions">
              <MoreHorizontal />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {exits.map((exit) => {
            const e = EXIT[exit];
            return (
              <DropdownMenuItem
                key={exit}
                variant={e.destructive ? 'destructive' : 'default'}
                onClick={() =>
                  e.command
                    ? runCommand({ command: e.command, selection: { ids: [messageId] }, onDone })
                    : setOpen(exit as 'edit' | 'fix-address')
                }
              >
                <e.icon />
                {e.label}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      {open === 'edit' && (
        <EditMessageDialog concertId={concertId} messageId={messageId} onClose={() => setOpen(null)} />
      )}
      {open === 'fix-address' && (
        <FixAddressDialog
          concertId={concertId}
          messageId={messageId}
          status={status}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function EditMessageDialog({
  concertId,
  messageId,
  onClose,
}: {
  concertId: number;
  messageId: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const id = React.useId();
  const [words, setWords] = React.useState<{ subject: string; bodyMd: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void loadMessageAction(concertId, messageId).then((result) => {
      if (!live) return;
      if (result.ok) setWords({ subject: result.value.subject, bodyMd: result.value.bodyMd });
      else setError(result.error);
    });
    return () => {
      live = false;
    };
  }, [concertId, messageId]);

  async function save() {
    if (!words) return;
    setSaving(true);
    setError(null);
    const result = await editMessageAction(concertId, messageId, words.subject, words.bodyMd);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit this message</DialogTitle>
          <DialogDescription>
            What is saved here is exactly what is sent. The library template is not changed.
          </DialogDescription>
        </DialogHeader>
        {!words && !error && <Skeleton className="h-48 w-full" />}
        {words && (
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor={`${id}-subject`}>Subject</FieldLabel>
              <Input
                id={`${id}-subject`}
                value={words.subject}
                maxLength={500}
                onChange={(event) => setWords({ ...words, subject: event.target.value })}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-body`}>Message (Markdown)</FieldLabel>
              <Textarea
                id={`${id}-body`}
                rows={14}
                className="font-mono text-xs"
                value={words.bodyMd}
                onChange={(event) => setWords({ ...words, bodyMd: event.target.value })}
              />
            </Field>
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!words || saving} onClick={() => void save()}>
            {saving && <Spinner data-icon="inline-start" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FixAddressDialog({
  concertId,
  messageId,
  status,
  onClose,
}: {
  concertId: number;
  messageId: number;
  status: MessageStatus;
  onClose: () => void;
}) {
  const router = useRouter();
  const id = React.useId();
  const [email, setEmail] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const then = status === 'FAILED' ? 'retry' : 'resend';

  async function save() {
    setSaving(true);
    setError(null);
    const result = await fixAddressAction(concertId, messageId, email);
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
    setDone(
      result.value.issue
        ? `Saved, and the message was ${result.value.then}. The new address still looks wrong: ${result.value.issue}`
        : `Saved, and the message was ${result.value.then}.`,
    );
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fix the address and {then}</DialogTitle>
          <DialogDescription>
            This changes the party’s contact email. Anything else waiting to be sent to them follows it.
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <Alert>
            <AlertDescription>{done}</AlertDescription>
          </Alert>
        ) : (
          <Field>
            <FieldLabel htmlFor={id}>New address</FieldLabel>
            <Input id={id} type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            <FieldDescription>Checked for typos and a real mail server before it is saved.</FieldDescription>
          </Field>
        )}
        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {done ? (
            <Button onClick={onClose}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!email.trim() || saving} onClick={() => void save()}>
                {saving && <Spinner data-icon="inline-start" />}
                Save and {then}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
