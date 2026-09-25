'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Check,
  Copy,
  Eye,
  KeyRound,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  UserPlus,
  UserRoundCog,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import { DataTable, DataTableColumnHeader, type DataTableColumn } from '@/components/data-table';
import { useCanEdit } from '@/components/auth/role';
import { formatInZone } from '@/lib/export';
import { ActionDialog } from '../../concerts/action-dialog';
import {
  createAccountAction,
  renameAccountAction,
  resetPasswordAction,
  setActiveAction,
  setRoleAction,
} from './actions';
import type { IssuedPassword, PeopleFormState } from './form-state';

export type PersonRow = {
  id: string;
  email: string;
  displayName: string | null;
  role: 'ADMIN' | 'VIEWER';
  isActive: boolean;
  lastLoginAt: string | null;
  isYou: boolean;
};

const ROLE_COPY = {
  ADMIN: 'Everything, including this screen.',
  VIEWER: 'Reads every screen with email addresses and phone numbers masked. Cannot change, send or export anything.',
} as const;

/**
 * Settings › People (spec/v3.md §28): the named console accounts.
 *
 * A handful of committee members, so a table with row actions. Passwords are
 * generated, shown once, and handed over in person — the same shape as an
 * usher's access code, and for the same reason: there is no invitation mail
 * and no self-service reset.
 */
export function PeopleScreen({ people, timeZone }: { people: PersonRow[]; timeZone: string }) {
  const [issued, setIssued] = useState<IssuedPassword | null>(null);
  const canEdit = useCanEdit();

  const columns: DataTableColumn<PersonRow>[] = [
    {
      accessorKey: 'displayName',
      meta: { label: 'Name' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <span className="font-medium">
          {row.original.displayName ?? row.original.email}
          {row.original.isYou && <span className="text-muted-foreground font-normal"> (you)</span>}
        </span>
      ),
    },
    {
      accessorKey: 'email',
      meta: { label: 'Email' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Email" />,
    },
    {
      accessorKey: 'role',
      meta: { label: 'Role' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Role" />,
      cell: ({ row }) =>
        row.original.role === 'ADMIN' ? (
          <Badge>
            <UserRoundCog data-icon="inline-start" />
            Admin
          </Badge>
        ) : (
          <Badge variant="secondary">
            <Eye data-icon="inline-start" />
            Viewer
          </Badge>
        ),
    },
    {
      accessorKey: 'isActive',
      meta: { label: 'Status' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'outline' : 'destructive'}>
          {row.original.isActive ? 'active' : 'deactivated'}
        </Badge>
      ),
    },
    {
      accessorKey: 'lastLoginAt',
      meta: { label: 'Last sign-in' },
      header: ({ column }) => <DataTableColumnHeader column={column} title="Last sign-in" />,
      cell: ({ row }) =>
        row.original.lastLoginAt ? (
          formatInZone(new Date(row.original.lastLoginAt), timeZone)
        ) : (
          <span className="text-muted-foreground">never</span>
        ),
    },
    ...(canEdit
      ? [
          {
            id: 'actions',
            enableHiding: false,
            enableSorting: false,
            meta: { label: 'Actions' },
            header: () => <span className="sr-only">Actions</span>,
            cell: ({ row }) => <PersonRowActions person={row.original} onIssued={setIssued} />,
          } satisfies DataTableColumn<PersonRow>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="text-muted-foreground max-w-prose text-sm">
            Who can sign in to this console. Admins can do everything; viewers read every
            screen with contact details masked and change nothing. Ushers are not listed here —
            they are added on each concert&rsquo;s Operators screen.
          </p>
        </div>

        <ActionDialog
          trigger={
            <Button>
              <UserPlus />
              Add person
            </Button>
          }
          title="Add a person"
          description="A password is generated for them and shown once. Pass it on in person."
          submitLabel="Create and show password"
          pendingLabel="Creating…"
          action={(formData) => createAccountAction({ error: null }, formData)}
          onSuccess={(result) => {
            const password = (result as PeopleFormState).issued;
            if (password) setIssued(password);
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="person-name">Name</FieldLabel>
              <Input id="person-name" name="displayName" required autoFocus maxLength={120} />
              <FieldDescription>What the Activity log shows for everything they do.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="person-email">Email</FieldLabel>
              <Input id="person-email" name="email" type="email" required autoComplete="off" />
              <FieldDescription>They sign in with this. Nothing is sent to it.</FieldDescription>
            </Field>
            <RoleField id="person-role" defaultValue="VIEWER" />
          </FieldGroup>
        </ActionDialog>
      </header>

      <DataTable
        columns={columns}
        data={people}
        getRowId={(row) => row.id}
        searchPlaceholder="Search people…"
        emptyTitle="Nobody yet"
        emptyDescription="Run scripts/bootstrap-admin.ts to create the first admin."
      />

      <PasswordDialog issued={issued} onClose={() => setIssued(null)} />
    </div>
  );
}

function RoleField({ id, defaultValue }: { id: string; defaultValue: 'ADMIN' | 'VIEWER' }) {
  const [role, setRole] = useState<'ADMIN' | 'VIEWER'>(defaultValue);
  return (
    <Field>
      <FieldLabel htmlFor={id}>Role</FieldLabel>
      <NativeSelect
        id={id}
        name="role"
        value={role}
        onChange={(event) => setRole(event.target.value as 'ADMIN' | 'VIEWER')}
      >
        <NativeSelectOption value="VIEWER">Viewer</NativeSelectOption>
        <NativeSelectOption value="ADMIN">Admin</NativeSelectOption>
      </NativeSelect>
      <FieldDescription>{ROLE_COPY[role]}</FieldDescription>
    </Field>
  );
}

type Pending = 'role' | 'active' | 'reset' | 'rename' | null;

/**
 * Row actions. Each consequential step is confirmed in a dialog that closes on
 * the *result*, so a refusal ("this is the only active admin") stays on screen.
 */
function PersonRowActions({
  person,
  onIssued,
}: {
  person: PersonRow;
  onIssued: (issued: IssuedPassword) => void;
}) {
  const [open, setOpen] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const name = person.displayName ?? person.email;
  const otherRole = person.role === 'ADMIN' ? 'VIEWER' : 'ADMIN';

  function run(action: () => Promise<PeopleFormState>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        setError(result.error);
        return;
      }
      setOpen(null);
      if (result.issued) onIssued({ ...result.issued, email: person.email });
      router.refresh();
    });
  }

  function close(next: boolean) {
    if (!next) {
      setOpen(null);
      setError(null);
    }
  }

  const confirm = {
    role: {
      title: otherRole === 'ADMIN' ? `Make ${name} an admin?` : `Make ${name} a viewer?`,
      body: ROLE_COPY[otherRole] + ' It takes effect on their next page load.',
      label: otherRole === 'ADMIN' ? 'Make admin' : 'Make viewer',
      go: () => run(() => setRoleAction(person.id, otherRole)),
    },
    active: {
      title: person.isActive ? `Deactivate ${name}?` : `Reactivate ${name}?`,
      body: person.isActive
        ? 'They are signed out on their next request and cannot sign in again until reactivated. What they did stays in the Activity log under their name.'
        : 'They can sign in again with their current password.',
      label: person.isActive ? 'Deactivate' : 'Reactivate',
      go: () => run(() => setActiveAction(person.id, !person.isActive)),
    },
    reset: {
      title: `Issue a new password for ${name}?`,
      body: 'Their current password stops working immediately, and you will have to pass the new one on. A browser they are already signed in on stays signed in — deactivate them if that is the worry.',
      label: 'Issue new password',
      go: () => run(() => resetPasswordAction(person.id)),
    },
  } as const;

  const current = open && open !== 'rename' ? confirm[open] : null;

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={`Actions for ${name}`} />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpen('rename')}>
            <Pencil />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpen('reset')}>
            <KeyRound />
            Issue a new password
          </DropdownMenuItem>
          {!person.isYou && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setOpen('role')}>
                {otherRole === 'ADMIN' ? <UserRoundCog /> : <Eye />}
                {otherRole === 'ADMIN' ? 'Make admin' : 'Make viewer'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setOpen('active')}>
                {person.isActive ? <ShieldOff /> : <ShieldCheck />}
                {person.isActive ? 'Deactivate' : 'Reactivate'}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={current !== null} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{current?.title}</AlertDialogTitle>
            <AlertDialogDescription>{current?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertTitle className="font-normal">{error}</AlertTitle>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button
              variant={open === 'active' && person.isActive ? 'destructive' : 'default'}
              disabled={isPending}
              onClick={() => current?.go()}
            >
              {isPending && <Spinner data-icon="inline-start" />}
              {current?.label}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={open === 'rename'} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {name}</DialogTitle>
            <DialogDescription>The Activity log shows this name for everything they do.</DialogDescription>
          </DialogHeader>
          <form
            action={(formData) => run(() => renameAccountAction({ error: null }, formData))}
            className="flex flex-col gap-4"
          >
            <input type="hidden" name="userId" value={person.id} />
            <Field>
              <FieldLabel htmlFor={`rename-${person.id}`}>Name</FieldLabel>
              <Input
                id={`rename-${person.id}`}
                name="displayName"
                defaultValue={person.displayName ?? ''}
                required
                maxLength={120}
                autoFocus
              />
            </Field>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertTitle className="font-normal">{error}</AlertTitle>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={isPending} onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending && <Spinner data-icon="inline-start" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * The one time anybody sees a password. Built like the operators' code dialog:
 * no click-outside, no Escape, an explicit acknowledgement as the only way out.
 */
function PasswordDialog({
  issued,
  onClose,
}: {
  issued: IssuedPassword | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.password);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The password is on screen and selectable, which is the fallback.
    }
  }

  return (
    <Dialog open={issued !== null} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Password for {issued?.displayName}</DialogTitle>
          <DialogDescription>
            They sign in at <code className="text-foreground">/login</code> with{' '}
            {issued?.email ? <strong>{issued.email}</strong> : 'their email'} and this password.
          </DialogDescription>
        </DialogHeader>

        <div className="my-2 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="issued-password">Password</Label>
            <InputGroup>
              <InputGroupInput
                id="issued-password"
                readOnly
                value={issued?.password ?? ''}
                className="font-mono text-base tracking-wider"
                onFocus={(event) => event.currentTarget.select()}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton size="icon-xs" aria-label="Copy password" onClick={copy}>
                  {copied ? <Check /> : <Copy />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </div>

          <Alert>
            <TriangleAlert />
            <AlertTitle>This is shown once</AlertTitle>
            <AlertDescription>
              It is stored only as a hash. If it is lost, issue a new password from their row —
              that replaces this one.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false);
              onClose();
            }}
          >
            I have saved it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
