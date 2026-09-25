'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Inbox,
  MailWarning,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Spinner } from '@/components/ui/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { STAGE_NEXT } from '@/lib/audience/filter';
import type { PartyRecord as Record_, RecordSeat } from '@/lib/audience/record';
import { OVERSELL_PHRASE } from '@/lib/registrations/confirmation';
import { ActionDialog } from '../../../action-dialog';
import { RegistrationFormDialog } from '../../registrations/registration-form-dialog';
import { addAttendeesAction, renameAttendeeAction } from '../../registrations/actions';
import type { PlayerOption, RegistrationRow, SegmentOption } from '../../registrations/queries';
import {
  ALLOCATION_LABEL,
  FlagBadges,
  SEAT_STATUS_LABEL,
  StageBadge,
  formatter,
} from '../badges';
import { COMMAND_ENTRIES, entry, useRunCommand } from '../command-host';

/**
 * The party record (spec/v3.md §22.4) — a full page, because it is where the
 * work is done: the header says where the party is and offers the next step;
 * the seats carry their own actions; the conversation, responses and activity
 * say how it got here.
 *
 * Every action is a command over this party's id or one seat's, run by the
 * page's command host, so what the record does and what the table does in
 * bulk are the same code (§23.1).
 */
export function PartyRecord({
  concertId,
  timeZone,
  record,
  segments,
  players,
}: {
  concertId: number;
  timeZone: string;
  record: Record_;
  segments: SegmentOption[];
  players: PlayerOption[];
}) {
  const { party, seats } = record;
  const runCommand = useRunCommand();
  const format = React.useMemo(() => formatter(timeZone), [timeZone]);
  const [notice, setNotice] = React.useState<string | null>(null);

  const partyRun = (command: string, params?: unknown) =>
    runCommand({ command, selection: { ids: [party.id] }, params });
  const seatRun = (command: string, ids: number[], params?: unknown) =>
    ids.length > 0 && runCommand({ command, selection: { ids }, params });

  const confirmedUnissued = seats.filter((s) => s.status === 'CONFIRMED' && !s.issued).map((s) => s.id);

  // The stage's next step as the primary button (§22.4).
  const primary: { label: string; onClick?: () => void; href?: string; icon?: React.ReactNode }[] = [];
  switch (party.stage) {
    case 'NEEDS_REVIEW':
      if (!party.approvedAt) primary.push({ label: 'Approve', onClick: () => partyRun('audience.approve', { includeFlagged: true }) });
      if (party.seats.pending > 0) {
        primary.push({ label: 'Grant extras', onClick: () => partyRun('audience.grant_extras') });
        primary.push({ label: 'Decline extras', onClick: () => partyRun('audience.decline_extras') });
      }
      break;
    case 'UNVERIFIED':
      primary.push({ label: 'Release', onClick: () => partyRun('audience.release') });
      primary.push({ label: 'Send reminder', onClick: () => partyRun('audience.remind_verification') });
      break;
    case 'NEEDS_TICKETS':
      primary.push({ label: 'Issue tickets', onClick: () => seatRun('seats.issue', confirmedUnissued) });
      primary.push({ label: 'Send tickets', href: `/admin/concerts/${concertId}/email`, icon: <Send data-icon="inline-start" /> });
      break;
    case 'READY_TO_SEND':
      primary.push({ label: 'Send tickets', href: `/admin/concerts/${concertId}/email`, icon: <Send data-icon="inline-start" /> });
      break;
    case 'WAITLISTED':
      primary.push({ label: 'Promote from waitlist', onClick: () => partyRun('audience.promote') });
      break;
    case 'CANCELLED':
      primary.push({ label: 'Restore', onClick: () => partyRun('audience.restore') });
      break;
  }

  // Flags are problems to look at (§21.2); the ones with a fix in this module
  // offer it beside the stage's step.
  const changed = seats.filter((s) => s.needsReissue).map((s) => s.id);
  if (party.flags.includes('CHANGED_AFTER_SEND') && changed.length > 0) {
    primary.push({ label: 'Reissue changed tickets', onClick: () => seatRun('seats.reissue', changed) });
    primary.push({ label: 'Dismiss as cosmetic', onClick: () => seatRun('seats.dismiss_reissue', changed) });
  }

  const partyCommands = COMMAND_ENTRIES.filter((e) => e.grain === 'parties');
  const groups = [...new Set(partyCommands.map((e) => e.group))];
  const liveSeatIds = seats.filter((s) => s.status !== 'CANCELLED').map((s) => s.id);

  const asRow: RegistrationRow = {
    id: party.id,
    showId: party.showId,
    showName: party.showName,
    segmentId: party.segmentId,
    segmentName: party.segmentName,
    audienceMode: party.audienceMode,
    contactName: party.contactName,
    contactEmail: party.contactEmail,
    contactPhone: party.contactPhone,
    playerId: party.playerId,
    playerName: party.playerName,
    roundLabel: party.roundLabel,
    source: party.source,
    status: party.status,
    requestedAt: new Date(party.requestedAt),
    seats: {
      confirmed: party.seats.confirmed,
      pending: party.seats.pending,
      waitlisted: party.seats.waitlisted,
      cancelled: party.seats.cancelled,
    },
    ticketsSent: party.seats.delivered,
    needsReissue: seats.filter((s) => s.needsReissue).length,
  };
  const segment = segments.find((s) => s.id === party.segmentId);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
          nativeButton={false}
          render={<Link href={`/admin/concerts/${concertId}/audience`} />}
        >
          <ArrowLeft data-icon="inline-start" />
          Audience
        </Button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{party.contactName}</h1>
              <StageBadge stage={party.stage} />
              <FlagBadges flags={party.flags} />
            </div>
            <dl className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Email</dt>
              <dd className="text-foreground">{party.contactEmail ?? '—'}</dd>
              <dt>Phone</dt>
              <dd className="text-foreground">{party.contactPhone ?? '—'}</dd>
              <dt>Seats in</dt>
              <dd className="text-foreground">
                {party.showName} · {party.segmentName}
                {party.playerName ? ` · invited by ${party.playerName}` : ''}
              </dd>
              <dt>Came from</dt>
              <dd className="text-foreground">
                {party.provenance}, requested {format.format(new Date(party.requestedAt))}
              </dd>
              <dt>Approved</dt>
              <dd className="text-foreground">
                {party.approvedAt
                  ? `${format.format(new Date(party.approvedAt))}${party.approvedBy ? ` by ${party.approvedBy}` : ''}`
                  : 'Not yet'}
              </dd>
              {party.needsVerification && (
                <>
                  <dt>Verified</dt>
                  <dd className="text-foreground">
                    {party.emailVerifiedAt ? format.format(new Date(party.emailVerifiedAt)) : 'Not yet'}
                  </dd>
                </>
              )}
            </dl>
            {party.stage && STAGE_NEXT[party.stage] && (
              <p className="text-sm">
                <span className="text-muted-foreground">Next: </span>
                {STAGE_NEXT[party.stage]}
              </p>
            )}
          </div>

          <ButtonGroup>
            {primary.map((action) =>
              action.href ? (
                <Button key={action.label} size="sm" nativeButton={false} render={<Link href={action.href} />}>
                  {action.icon}
                  {action.label}
                </Button>
              ) : (
                <Button key={action.label} size="sm" onClick={action.onClick}>
                  {action.label}
                </Button>
              ),
            )}
            <RegistrationFormDialog
              concertId={concertId}
              timeZone={timeZone}
              segments={segments}
              players={players}
              registration={asRow}
              onSuccess={(result) => setNotice(result.message ?? null)}
              trigger={
                <Button size="sm" variant="outline">
                  <Pencil data-icon="inline-start" />
                  Edit
                </Button>
              }
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" variant="outline" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-64">
                {groups.map((group, index) => (
                  <React.Fragment key={group}>
                    {index > 0 && <DropdownMenuSeparator />}
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{group}</DropdownMenuLabel>
                      {partyCommands
                        .filter((e) => e.group === group)
                        .map((e) => (
                          <DropdownMenuItem
                            key={e.command}
                            variant={e.destructive ? 'destructive' : 'default'}
                            onClick={() =>
                              partyRun(e.command, e.command === 'audience.approve' ? { includeFlagged: true } : undefined)
                            }
                          >
                            <e.icon />
                            {e.label}
                          </DropdownMenuItem>
                        ))}
                    </DropdownMenuGroup>
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>

        {notice && (
          <Alert role="status">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {party.emailIssue && !party.emailIssueAcceptedAt && (
          <Alert variant="destructive">
            <MailWarning />
            <AlertTitle>This address may not receive mail</AlertTitle>
            <AlertDescription>
              <p>{party.emailIssue}</p>
              <p>Send tickets skips this party until the address is fixed, or accepted as it is.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => partyRun('audience.check_address')}>
                  Check again
                </Button>
                <Button size="sm" variant="outline" onClick={() => partyRun('audience.accept_address')}>
                  The address is right
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="seats-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="seats-heading" className="text-base font-semibold">
            Seats{' '}
            <span className="text-muted-foreground text-sm font-normal tabular-nums">
              {party.seats.confirmed} confirmed · {party.seats.issued} issued · {party.seats.delivered} sent ·{' '}
              {party.seats.admitted} in
            </span>
          </h2>
          <ButtonGroup>
            <AddSeats
              concertId={concertId}
              registrationId={party.id}
              contactName={party.contactName}
              playerInvited={party.audienceMode === 'PLAYER_INVITED'}
              maxSeats={segment?.maxTicketsPerResponse ?? null}
              onDone={setNotice}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" variant="outline" disabled={liveSeatIds.length === 0}>
                    All seats
                    <ChevronDown data-icon="inline-end" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-56">
                {COMMAND_ENTRIES.filter((e) => e.grain === 'seats').map((e) => (
                  <DropdownMenuItem
                    key={e.command}
                    variant={e.destructive ? 'destructive' : 'default'}
                    onClick={() => seatRun(e.command, liveSeatIds)}
                  >
                    <e.icon />
                    {e.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Guest</TableHead>
                <TableHead>Seat</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Door</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {seats.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground text-center">
                    No seats.
                  </TableCell>
                </TableRow>
              )}
              {seats.map((seat) => (
                <SeatRow
                  key={seat.id}
                  concertId={concertId}
                  seat={seat}
                  format={format}
                  onCommand={(command) => seatRun(command, [seat.id])}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <Tabs defaultValue="conversation">
        <TabsList variant="line">
          <TabsTrigger value="conversation">
            Conversation
            <Badge variant="secondary" className="tabular-nums">
              {record.messages.length}
            </Badge>
          </TabsTrigger>
          <TabsTrigger value="responses">Responses</TabsTrigger>
          <TabsTrigger value="activity">
            Activity
            <Badge variant="secondary" className="tabular-nums">
              {record.activity.length}
            </Badge>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="pt-3">
          <Conversation record={record} format={format} />
        </TabsContent>
        <TabsContent value="responses" className="pt-3">
          <Responses record={record} format={format} />
        </TabsContent>
        <TabsContent value="activity" className="pt-3">
          <ActivityList record={record} format={format} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SeatRow({
  concertId,
  seat,
  format,
  onCommand,
}: {
  concertId: number;
  seat: RecordSeat;
  format: Intl.DateTimeFormat;
  onCommand: (command: string) => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(seat.placeholder ? '' : seat.fullName);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  function save() {
    const data = new FormData();
    data.set('fullName', name);
    startTransition(async () => {
      const result = await renameAttendeeAction(concertId, seat.id, { error: null }, data);
      if (result.error) {
        setError(result.error);
        return;
      }
      setError(null);
      setEditing(false);
      router.refresh();
    });
  }

  const cancelled = seat.status === 'CANCELLED';
  const actions = COMMAND_ENTRIES.filter((e) => e.grain === 'seats');

  return (
    <TableRow className={cancelled ? 'opacity-60' : undefined}>
      <TableCell>
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Blank for a placeholder"
              aria-label="Guest name"
              className="h-8 w-48"
              autoFocus
              maxLength={200}
            />
            <Button size="sm" type="submit" disabled={isPending}>
              {isPending ? <Spinner /> : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <button
            type="button"
            className="group flex items-center gap-1.5 text-left"
            onClick={() => setEditing(true)}
            aria-label={`Rename ${seat.fullName}`}
          >
            <span className={seat.placeholder ? 'text-muted-foreground italic' : 'font-medium'}>
              {seat.fullName}
            </span>
            <Pencil className="text-muted-foreground size-3 opacity-0 group-hover:opacity-100" aria-hidden />
          </button>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1 text-sm">
          <Badge variant={seat.status === 'CONFIRMED' ? 'secondary' : 'outline'}>
            {SEAT_STATUS_LABEL[seat.status]}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {ALLOCATION_LABEL[seat.allocationType]} · asked {format.format(new Date(seat.requestedAt))}
          </span>
          {seat.overCapacity && <Badge variant="destructive">Over capacity</Badge>}
        </div>
      </TableCell>
      <TableCell>
        {seat.ticketCode ? (
          <div className="flex flex-col text-sm">
            <span className="font-mono">{seat.ticketCode}</span>
            <span className="text-muted-foreground text-xs">
              {seat.templateName ? `${seat.templateName} v${seat.templateVersion}` : 'Design not pinned'}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">Not issued</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1 text-sm">
          {seat.sentAt ? (
            <span>
              {seat.sentSource === 'MANUAL' ? 'By hand' : 'Emailed'} {format.format(new Date(seat.sentAt))}
            </span>
          ) : (
            <span className="text-muted-foreground">Not sent</span>
          )}
          {seat.needsReissue && <Badge variant="destructive">Changed after send</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-sm">
        {seat.checkIn ? (
          <span>
            In {format.format(new Date(seat.checkIn.at))}
            {seat.checkIn.source === 'MANUAL' ? ' (manual)' : ''}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${seat.fullName}`} />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {seat.issued && (
              <>
                <DropdownMenuItem
                  render={<a href={`/api/tickets/${seat.id}/pdf?download=1`} />}
                >
                  <Download />
                  Download PDF
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <Pencil />
              Rename
            </DropdownMenuItem>
            {actions.map((e) => (
              <DropdownMenuItem
                key={e.command}
                variant={e.destructive ? 'destructive' : 'default'}
                onClick={() => onCommand(e.command)}
              >
                <e.icon />
                {entry(e.command).label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function AddSeats({
  concertId,
  registrationId,
  contactName,
  playerInvited,
  maxSeats,
  onDone,
}: {
  concertId: number;
  registrationId: number;
  contactName: string;
  playerInvited: boolean;
  maxSeats: number | null;
  onDone: (message: string | null) => void;
}) {
  const id = React.useId();
  return (
    <ActionDialog
      trigger={
        <Button size="sm" variant="outline">
          <Plus data-icon="inline-start" />
          Add seats
        </Button>
      }
      title="Add seats"
      description="Through the engine like any other grant: a guest added after the segment filled waits rather than quietly appearing in a full room."
      submitLabel="Add seats"
      pendingLabel="Adding…"
      onSuccess={(result) => onDone(result.message ?? null)}
      action={(formData) => addAttendeesAction(concertId, registrationId, { error: null }, formData)}
    >
      <FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-seats`}>Seats</FieldLabel>
            <Input id={`${id}-seats`} name="seats" type="number" min={1} max={maxSeats ?? undefined} defaultValue={1} />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>Seat type</FieldLabel>
            <NativeSelect id={`${id}-type`} name="allocationType" defaultValue={playerInvited ? 'BASE' : 'EXTRA'}>
              {playerInvited && <option value="BASE">Base</option>}
              <option value="EXTRA">Extra</option>
              <option value="HELD">Held</option>
              <option value="COMP">Complimentary</option>
            </NativeSelect>
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${id}-names`}>Guest names</FieldLabel>
          <Textarea id={`${id}-names`} name="guestNames" rows={3} placeholder="One name per line" />
          <FieldDescription>Optional — a seat with no name tickets as “Guest of {contactName}”.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-override`}>Seat them even if the segment or hall is full</FieldLabel>
          <Input
            id={`${id}-override`}
            name="overrideConfirmation"
            autoComplete="off"
            placeholder={`Type ${OVERSELL_PHRASE} to allow it`}
          />
          <FieldDescription>Blank means a seat that does not fit waits instead.</FieldDescription>
        </Field>
      </FieldGroup>
    </ActionDialog>
  );
}

const PURPOSE_LABEL: Record<string, string> = {
  RECEIPT: 'Receipt',
  VERIFICATION: 'Verification',
  TICKETS: 'Tickets',
  EXTRAS_DECISION: 'Extras decision',
  CANCELLATION: 'Cancellation',
  REMINDER: 'Reminder',
  FEEDBACK: 'Feedback',
  NOTES_DIGEST: 'Notes digest',
  PLAYER_INVITE: 'Invitation',
  REPLY: 'Reply',
};

function Conversation({ record, format }: { record: Record_; format: Intl.DateTimeFormat }) {
  if (record.messages.length === 0) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Inbox className="size-4" aria-hidden /> Nothing sent to or received from this party yet.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2">
      {record.messages.map((m) => (
        <li
          key={m.key}
          className={
            m.direction === 'INBOUND'
              ? 'bg-muted/50 ml-8 flex flex-col gap-1 rounded-lg border p-3'
              : 'mr-8 flex flex-col gap-1 rounded-lg border p-3'
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {m.direction === 'OUTBOUND' ? (
              <>
                <Badge variant="outline">{PURPOSE_LABEL[m.purpose ?? ''] ?? m.purpose}</Badge>
                <Badge variant={m.status === 'SENT' ? 'secondary' : m.status === 'FAILED' || m.bounce ? 'destructive' : 'outline'}>
                  {m.bounce ? 'Bounced' : m.status?.toLowerCase()}
                </Badge>
                <span className="text-muted-foreground">to {m.toEmail}</span>
              </>
            ) : (
              <>
                <Badge variant={m.isBounce ? 'destructive' : 'default'}>{m.isBounce ? 'Bounce' : 'Reply'}</Badge>
                <span className="text-muted-foreground">from {m.fromEmail}</span>
                {!m.isBounce && !m.handledAt && <Badge variant="destructive">Waiting</Badge>}
              </>
            )}
            <span className="text-muted-foreground ml-auto tabular-nums">{format.format(new Date(m.at))}</span>
          </div>
          <p className="font-medium">{m.subject}</p>
          {m.text && <p className="text-muted-foreground line-clamp-4 text-sm whitespace-pre-wrap">{m.text}</p>}
          {m.lastError && m.status === 'FAILED' && (
            <p className="text-destructive text-sm">
              Failed after {m.attempts} attempt{m.attempts === 1 ? '' : 's'}: {m.lastError}
            </p>
          )}
          {m.bounce && <p className="text-destructive text-sm">{m.bounce}</p>}
        </li>
      ))}
    </ol>
  );
}

function Responses({ record, format }: { record: Record_; format: Intl.DateTimeFormat }) {
  const hasCustom = record.custom && Object.keys(record.custom).length > 0;
  if (record.responses.length === 0 && !record.import && !hasCustom) {
    return <p className="text-muted-foreground text-sm">Entered by an admin; there is no form response or file row.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {record.responses.map((response) => (
        <div key={response.id} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">{response.formTitle}</span>
            {response.superseded ? (
              <Badge variant="outline">Replaced by a later edit</Badge>
            ) : (
              <Badge variant="secondary">Current</Badge>
            )}
            <span className="text-muted-foreground ml-auto tabular-nums">
              Submitted {format.format(new Date(response.submittedAt))}
            </span>
          </div>
          <pre className="bg-muted/50 max-h-72 overflow-auto rounded-md p-2 text-xs">
            {JSON.stringify(response.raw, null, 2)}
          </pre>
        </div>
      ))}
      {record.import && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm">
            <span className="font-medium">Imported from {record.import.filename}</span>{' '}
            <span className="text-muted-foreground">{format.format(new Date(record.import.importedAt))}</span>
          </p>
          {record.import.rows.map((row) => (
            <div key={`${row.rowNumber}:${row.seatIndex}`} className="flex flex-col gap-1">
              <span className="text-muted-foreground text-xs">
                Row {row.rowNumber}
                {row.seatIndex > 0 ? `, seat ${row.seatIndex + 1}` : ''}
              </span>
              <pre className="bg-muted/50 max-h-48 overflow-auto rounded-md p-2 text-xs">
                {JSON.stringify(row.raw, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
      {hasCustom && (
        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <span className="text-sm font-medium">Answers kept on the party</span>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {Object.entries(record.custom!).map(([key, value]) => (
              <React.Fragment key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
              </React.Fragment>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function ActivityList({ record, format }: { record: Record_; format: Intl.DateTimeFormat }) {
  if (record.activity.length === 0) {
    return <p className="text-muted-foreground text-sm">No recorded changes yet.</p>;
  }
  return (
    <ol className="flex flex-col divide-y rounded-lg border">
      {record.activity.map((row) => (
        <li key={row.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{row.action}</span>
            {row.entityType === 'attendee' && <Badge variant="outline">seat {row.entityId}</Badge>}
            <span className="text-muted-foreground ml-auto tabular-nums">{format.format(new Date(row.at))}</span>
          </div>
          <span className="text-muted-foreground text-xs">
            {row.actor ?? 'System'}
            {row.reason ? ` — ${row.reason}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}
