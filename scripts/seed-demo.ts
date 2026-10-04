/**
 * The demo: a fictional concert, end to end (spec/v3.md §31).
 *
 * Builds `docs/context.example.md`'s *Autumn Serenade* — an open rehearsal that
 * already happened and a gala still ahead — through the app's own paths where a
 * script can reach them: `claim_seats()` allocates, `reviewAtIntake()` reviews,
 * `issueTickets()` mints and pins, `queueBlast()` and `dispatchBatch()` deliver
 * through the no-network stream transport, `recordWalkIn()` records walk-ins.
 * Only what a person does at a time a script cannot be — scanning at the door,
 * replying from their own mailbox, answering feedback — is written directly.
 *
 *   pnpm demo:seed            # an empty database, or one this script seeded
 *   pnpm demo:seed --reset    # wipe a demo database and seed it again
 *
 * **It refuses any database holding a concert it did not create.** The first
 * run on an empty database marks it as a demo (`demo.instance`); `--reset`
 * wipes only a marked one. Production has concerts and no mark, so neither
 * path can touch it.
 *
 * Dates are relative to the day it runs, so the demo always has one show behind
 * it and one ahead. Names are invented; addresses are at reserved domains, and
 * the demo has no mailbox (§31), so nothing it queues can leave.
 *
 * Needs `DATABASE_URL`; `NEXT_PUBLIC_SUPABASE_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` for the accounts (the QA Auth stub serves too);
 * `TICKET_ASSET_DIR` or the `ticket-assets` bucket for the booklet; and
 * `DEMO_ADMIN_PASSWORD`, `DEMO_VIEWER_PASSWORD` and `DEMO_OPERATOR_CODE`.
 */
import './load-env';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { sql as dsql } from 'drizzle-orm';
import { getDb, getSql } from '../src/db/client';
import { claimSeats, lockShowForClaim, promoteSeats, type SeatRequest } from '../src/db/allocation';
import { seedDefaultTemplates } from '../src/lib/email/defaults';
import { queueBlast } from '../src/lib/email/queue';
import { confirmBatch } from '../src/lib/email/mutations';
import { dispatchBatch } from '../src/lib/email/dispatch';
import { createStreamTransport } from '../src/lib/mail/transport';
import { blankFormSchema } from '../src/lib/forms/templates';
import { reviewAtIntake } from '../src/lib/intake/review';
import { mintUpdateToken } from '../src/lib/intake/update-link';
import { mintVerificationToken } from '../src/lib/registrations/verification';
import { ensureConcertTemplates } from '../src/lib/tickets/seed-templates';
import { issueTickets } from '../src/lib/tickets/issue';
import { putAsset } from '../src/lib/tickets/assets';
import { recordWalkIn } from '../src/lib/checkin/walk-ins';
import { OPERATOR_EMAIL_DOMAIN } from '../src/lib/auth/operator-slug';
import type { FormSchema } from '../src/lib/forms/schema';

const sql = getSql();
const RESET = process.argv.includes('--reset');
const MARK = 'demo.instance';

// ── The example concert's facts (docs/context.example.md §5) ──────────────────

/** The example concert's zone. Its offset is fixed (no DST), so a date is arithmetic. */
const TIMEZONE = 'Asia/Kuala_Lumpur';
const UTC_OFFSET_HOURS = 8;

const CONCERT = {
  name: 'Autumn Serenade',
  slug: 'autumn-serenade',
  season: 'Autumn',
  sender: 'Lakeside Community Orchestra',
  practicalInfo: [
    '**Getting there.** The Lakeside Arts Centre is a five-minute walk from Lakeside station. The car park opens an hour before doors.',
    '',
    '**Doors.** Seating is unreserved; doors open 45 minutes before the start.',
    '',
    '**Your ticket.** Show the QR code on your phone or on paper. One code per person — everyone in your party has their own.',
  ].join('\n'),
};

const REHEARSAL = {
  name: 'Open rehearsal',
  day: -9,
  doors: '14:30',
  start: '15:00',
  end: '16:45',
  venue: 'Lakeside Arts Centre, Studio Hall',
  capacity: 200,
};

const GALA = {
  name: 'Gala evening',
  day: 21,
  doors: '18:45',
  start: '19:30',
  end: '21:45',
  venue: 'Lakeside Arts Centre, Main Hall',
  capacity: 320,
  publicCapacity: 240,
  playerCapacity: 80,
  baseQuota: 1,
  baseClaimDeadlineDay: 7,
};

const PLAYERS = 60;
const PARTY_CAP = 4;

// ── Deterministic randomness, so every reset builds the same demo ─────────────

let seed = 0x5eed;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const between = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));

const GIVEN = [
  'Aaron', 'Adeline', 'Aisha', 'Alvin', 'Amelia', 'Ananya', 'Arjun', 'Beatrice', 'Benedict', 'Caleb',
  'Celine', 'Chloe', 'Darius', 'Delphine', 'Elena', 'Emeric', 'Farhan', 'Felicity', 'Gideon', 'Hana',
  'Hugo', 'Imran', 'Iris', 'Jasper', 'Joanna', 'Kavya', 'Kieran', 'Lena', 'Lucian', 'Maya',
  'Mikhail', 'Nadia', 'Naveen', 'Oriana', 'Oscar', 'Petra', 'Quentin', 'Rafael', 'Rosalind', 'Sabrina',
  'Samuel', 'Selina', 'Tobias', 'Ursula', 'Valerie', 'Wilhelm', 'Xavier', 'Yasmin', 'Yusuf', 'Zara',
];
const FAMILY = [
  'Abernethy', 'Albrecht', 'Bellamy', 'Castellano', 'Delacroix', 'Ellingham', 'Fairbairn', 'Galloway',
  'Hartigan', 'Ingleby', 'Jaramillo', 'Kingsley', 'Lindqvist', 'Marchetti', 'Northcott', 'Okonkwo',
  'Pemberton', 'Quayle', 'Rasmussen', 'Sorensen', 'Thackeray', 'Underhill', 'Vasquez', 'Whitcombe',
  'Yardley', 'Zielinski',
];
const DOMAINS = ['example.com', 'example.org', 'example.net'];
const SECTIONS: [string, string][] = [
  ['Violin I', 'Strings'], ['Violin II', 'Strings'], ['Viola', 'Strings'], ['Cello', 'Strings'],
  ['Double bass', 'Strings'], ['Flute', 'Woodwind'], ['Oboe', 'Woodwind'], ['Clarinet', 'Woodwind'],
  ['Bassoon', 'Woodwind'], ['Horn', 'Brass'], ['Trumpet', 'Brass'], ['Trombone', 'Brass'],
  ['Percussion', 'Percussion'], ['Harp', 'Strings'],
];

const usedNames = new Set<string>();
function person(): { name: string; email: string; phone: string } {
  let name: string;
  do name = `${pick(GIVEN)} ${pick(FAMILY)}`;
  while (usedNames.has(name));
  usedNames.add(name);
  const email = `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@${pick(DOMAINS)}`;
  const phone = `+60 1${between(0, 9)}-555 ${String(between(0, 9999)).padStart(4, '0')}`;
  return { name, email, phone };
}

// ── Time, in the example concert's zone ───────────────────────────────────────

const today = (() => {
  const local = new Date(Date.now() + UTC_OFFSET_HOURS * 3_600_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate() };
})();

/** `day` days from today at a local wall-clock time, as an instant. */
function at(day: number, time: string): Date {
  const [h, min] = time.split(':').map(Number);
  return new Date(Date.UTC(today.y, today.m, today.d + day, h - UTC_OFFSET_HOURS, min));
}
const isoDate = (day: number) => at(day, '12:00').toISOString().slice(0, 10);
/** postgres.js hands a `timestamptz` back as a string here, so either is accepted. */
const minutesAfter = (instant: Date | string, minutes: number) =>
  new Date(new Date(instant).getTime() + minutes * 60_000);

// ── Guard and reset ───────────────────────────────────────────────────────────

async function guard(): Promise<void> {
  const [state] = await sql<{ concerts: number; marked: boolean }[]>`
    select (select count(*)::int from concerts) as concerts,
           exists (select 1 from system_settings where key = ${MARK} and value = 'true'::jsonb) as marked
  `;
  if (state.marked && !RESET) {
    throw new Error('This database already holds the demo. Run with --reset to build it again.');
  }
  if (!state.marked && state.concerts > 0) {
    throw new Error(
      `This database holds ${state.concerts} concert(s) the demo did not create. ` +
        'The demo seed only writes to an empty database or to one it marked itself.',
    );
  }
  if (state.marked && RESET) {
    await sql.unsafe(`
      do $$
      declare stmt text;
      begin
        select 'truncate table ' || string_agg(format('%I.%I', schemaname, tablename), ', ')
               || ' restart identity cascade'
          into stmt
          from pg_tables
         where schemaname = 'public' and tablename <> '__drizzle_migrations';
        if stmt is not null then execute stmt; end if;
      end $$;
    `);
    console.log('Wiped the demo database.');
  }
}

async function setSystem(key: string, value: unknown): Promise<void> {
  await sql`
    insert into system_settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
}

// ── Accounts ──────────────────────────────────────────────────────────────────

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

const authAdmin = createClient(requiredEnv('NEXT_PUBLIC_SUPABASE_URL'), requiredEnv('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { autoRefreshToken: false, persistSession: false },
}).auth.admin;

/** Find-or-create, so a reset reuses the Auth users and only resets their passwords. */
async function authUser(email: string, password: string): Promise<string> {
  const { data, error } = await authAdmin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new Error(`Supabase Auth would not list users: ${error.message}`);
  const existing = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    const updated = await authAdmin.updateUserById(existing.id, { password });
    if (updated.error) throw new Error(`Supabase Auth refused ${email}'s password: ${updated.error.message}`);
    return existing.id;
  }
  const created = await authAdmin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    throw new Error(`Supabase Auth refused ${email}: ${created.error?.message ?? 'no user returned'}`);
  }
  return created.data.user.id;
}

async function account(email: string, displayName: string, role: 'ADMIN' | 'VIEWER' | 'OPERATOR', password: string) {
  const id = await authUser(email, password);
  await sql`
    insert into app_users (id, email, display_name, role, is_active)
    values (${id}, ${email}, ${displayName}, ${role}, true)
    on conflict (id) do update set email = excluded.email, display_name = excluded.display_name,
                                   role = excluded.role, is_active = true, deleted_at = null
  `;
  return id;
}

// ── Parties ───────────────────────────────────────────────────────────────────

type Segment = { id: number; showId: number };

type PartyPlan = {
  segment: Segment;
  source: 'FORM' | 'IMPORT';
  formId?: number;
  importBatchId?: number;
  playerId?: number | null;
  contact: { name: string; email: string; phone: string | null };
  /** Seats after the registrant's own (public) or the player's claim (player). Null is an unnamed guest. */
  seats: SeatRequest[];
  requestedAt: Date;
  /** A public party with a verification step it has not finished. */
  unverified?: boolean;
  emailIssue?: string;
};

async function createParty(plan: PartyPlan): Promise<number> {
  return getDb().transaction(async (tx) => {
    await lockShowForClaim(plan.segment.showId, tx);

    let responseId: number | null = null;
    if (plan.source === 'FORM' && plan.formId) {
      const [form] = await tx.execute<{ schema: FormSchema; kind: string }>(dsql`
        select schema, kind::text as kind from registration_forms where id = ${plan.formId}
      `);
      const guests = plan.seats
        .filter((_, i) => form.kind === 'PLAYER' || i > 0)
        .map((s) => ({ full_name: s.fullName ?? '', email: s.email ?? '' }));
      const raw =
        form.kind === 'PLAYER'
          ? {
              registrant: { contact_name: plan.contact.name, contact_email: plan.contact.email, contact_phone: plan.contact.phone ?? '' },
              base_seats: plan.seats.filter((s) => s.allocationType === 'BASE').map((s) => ({ full_name: s.fullName ?? '', email: s.email ?? '' })),
              extra_seats: plan.seats.filter((s) => s.allocationType === 'EXTRA').map((s) => ({ full_name: s.fullName ?? '', email: s.email ?? '' })),
            }
          : {
              registrant: { contact_name: plan.contact.name, contact_email: plan.contact.email, contact_phone: plan.contact.phone ?? '' },
              party: guests,
            };
      const [response] = await tx.execute<{ id: string }>(dsql`
        insert into form_responses (form_id, raw, form_schema, submitted_at, edit_token, user_agent)
        values (${plan.formId}, ${JSON.stringify(raw)}::text::jsonb, ${JSON.stringify(form.schema)}::text::jsonb,
                ${plan.requestedAt.toISOString()}::timestamptz, ${randomUUID().replaceAll('-', '')},
                'demo seed')
        returning id
      `);
      responseId = Number(response.id);
    }

    const verificationToken = plan.source === 'FORM' && !plan.playerId ? mintVerificationToken() : null;
    const [registration] = await tx.execute<{ id: string }>(dsql`
      insert into registrations (
        show_id, segment_id, player_id, source, form_response_id, import_batch_id,
        contact_name, contact_email, contact_phone, status, requested_at, created_at,
        verification_token, email_verified_at, update_token, email_issue, email_checked_at
      ) values (
        ${plan.segment.showId}, ${plan.segment.id}, ${plan.playerId ?? null}, ${plan.source}::registration_source,
        ${responseId}, ${plan.importBatchId ?? null},
        ${plan.contact.name}, ${plan.contact.email}, ${plan.contact.phone}, 'WAITLIST',
        ${plan.requestedAt.toISOString()}::timestamptz, ${plan.requestedAt.toISOString()}::timestamptz,
        ${verificationToken},
        ${verificationToken && !plan.unverified ? minutesAfter(plan.requestedAt, between(2, 90)).toISOString() : null}::timestamptz,
        ${mintUpdateToken()}, ${plan.emailIssue ?? null}, ${plan.requestedAt.toISOString()}::timestamptz
      )
      returning id
    `);
    const registrationId = Number(registration.id);
    if (responseId) {
      await tx.execute(dsql`update form_responses set registration_id = ${registrationId} where id = ${responseId}`);
    }

    await claimSeats(
      plan.segment.id,
      registrationId,
      plan.seats.map((s) => ({ ...s, requestedAt: plan.requestedAt })),
      { executor: tx },
    );
    await tx.execute(dsql`
      update registrations r
         set status = case
               when exists (select 1 from attendees a where a.registration_id = r.id
                             and a.status = 'CONFIRMED' and a.deleted_at is null) then 'CONFIRMED'
               when exists (select 1 from attendees a where a.registration_id = r.id
                             and a.status = 'PENDING_REVIEW' and a.deleted_at is null) then 'PENDING_REVIEW'
               else 'WAITLIST'
             end::booking_status
       where r.id = ${registrationId}
    `);
    await tx.execute(dsql`update attendees set created_at = ${plan.requestedAt.toISOString()}::timestamptz where registration_id = ${registrationId}`);
    await reviewAtIntake(tx, registrationId);
    return registrationId;
  });
}

/** The registrant first, then guests; some guests left unnamed, as people do. */
function publicSeats(contact: { name: string; email: string }, size: number, unnamedChance: number): SeatRequest[] {
  const seats: SeatRequest[] = [{ fullName: contact.name, email: contact.email, allocationType: 'EXTRA' }];
  for (let i = 1; i < size; i++) {
    seats.push({ fullName: random() < unnamedChance ? null : person().name, email: null, allocationType: 'EXTRA' });
  }
  return seats;
}

const partySize = () => pick([1, 1, 2, 2, 2, 2, 3, 3, 4]);

async function approve(registrationIds: number[], adminId: string, when: Date): Promise<void> {
  if (registrationIds.length === 0) return;
  await sql`
    update registrations set approved_at = ${when.toISOString()}::timestamptz, approved_by = ${adminId}
     where id = any(${registrationIds}::bigint[]) and approved_at is null
  `;
}

async function attendeeIds(registrationIds: number[]): Promise<number[]> {
  const rows = await sql<{ id: string }[]>`
    select id from attendees where registration_id = any(${registrationIds}::bigint[])
       and status = 'CONFIRMED' and deleted_at is null
  `;
  return rows.map((r) => Number(r.id));
}

/** Drafts the blast and confirms it, as an admin pressing Send on the blast screen would. */
async function blast(segmentId: number, templateKey: string, adminId: string): Promise<void> {
  await queueBlast({ segmentId, templateKey });
  await confirmBatch({ segmentId, templateKey, actorId: adminId });
}

/** Delivers whatever is queued, through the stream transport: real MIME, no socket. */
async function dispatchAll(): Promise<number> {
  const transport = createStreamTransport(CONCERT.sender, 'tickets@example.org');
  let sent = 0;
  for (;;) {
    const result = await dispatchBatch({ transport });
    sent += result.sent;
    if (result.failed > 0) throw new Error(`The demo dispatch failed ${result.failed} message(s).`);
    if ((result.remaining ?? 0) === 0 || result.sent === 0) break;
  }
  return sent;
}

/** Moves a party's delivery into the past, so the timeline reads like a real run-up. */
async function backdateDelivery(registrationIds: number[], from: Date, to: Date): Promise<void> {
  for (const id of registrationIds) {
    const when = new Date(from.getTime() + random() * (to.getTime() - from.getTime()));
    await sql`
      update email_outbox set created_at = ${when.toISOString()}::timestamptz,
             sent_at = ${minutesAfter(when, 1).toISOString()}::timestamptz,
             updated_at = ${minutesAfter(when, 1).toISOString()}::timestamptz
       where registration_id = ${id}
    `;
    await sql`
      update attendees set ticket_issued_at = ${when.toISOString()}::timestamptz,
             ticket_sent_at = case when ticket_sent_at is null then null
                                   else ${minutesAfter(when, 1).toISOString()}::timestamptz end
       where registration_id = ${id}
    `;
  }
}

// ── The booklet ───────────────────────────────────────────────────────────────

async function bookletPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const serif = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const pages: [string, string[]][] = [
    ['Autumn Serenade', ['Lakeside Community Orchestra', '', 'Open rehearsal and gala evening', 'Lakeside Arts Centre']],
    ['Programme', [
      'Overture — An Autumn Morning',
      'Serenade for Strings in four movements',
      'Interval',
      'Symphonic Suite — The Lake at Dusk',
      'Encore',
    ]],
    ['The orchestra', [
      'About sixty volunteer players, rehearsing every Thursday evening.',
      'Admission to every concert is free.',
      '',
      'Thank you for coming.',
    ]],
  ];
  for (const [title, lines] of pages) {
    const page = doc.addPage([420, 595]);
    page.drawText(title, { x: 40, y: 520, size: 26, font: bold, color: rgb(0.15, 0.2, 0.3) });
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 470 - i * 22, size: 13, font: serif }));
  }
  return doc.save();
}

// ── The build ─────────────────────────────────────────────────────────────────

async function main() {
  await guard();

  // System values, the email templates, the mark.
  const require = createRequire(import.meta.url);
  execFileSync(process.execPath, [require.resolve('tsx/cli'), 'scripts/seed-settings.ts'], { stdio: 'inherit' });
  await seedDefaultTemplates();
  await setSystem(MARK, true);
  await setSystem('email.from_name', CONCERT.sender);
  // The demo's tick dispatches; with no mailbox every send would fail, so the
  // demo starts with nothing left queued (below) and no inbox to read.

  // Accounts.
  const adminId = await account('admin@example.org', 'Demo admin', 'ADMIN', requiredEnv('DEMO_ADMIN_PASSWORD'));
  const viewerId = await account('visitor@example.org', 'Visitor', 'VIEWER', requiredEnv('DEMO_VIEWER_PASSWORD'));
  const operatorCode = requiredEnv('DEMO_OPERATOR_CODE');
  const ushers: { id: string; name: string }[] = [];
  for (const [slug, name] of [['aisyah', 'Aisyah'], ['jun-hao', 'Jun Hao'], ['priya', 'Priya']]) {
    ushers.push({ id: await account(`${slug}@${OPERATOR_EMAIL_DOMAIN}`, name, 'OPERATOR', operatorCode), name });
  }
  void viewerId;

  // The concert.
  const [concert] = await sql<{ id: string }[]>`
    insert into concerts (name, slug, season, starts_on, ends_on, status, timezone, portal_enabled,
                          practical_info_md, defaults)
    values (${CONCERT.name}, ${CONCERT.slug}, ${CONCERT.season}, ${isoDate(REHEARSAL.day)}::date,
            ${isoDate(GALA.day)}::date, 'ACTIVE', ${TIMEZONE}, true, ${CONCERT.practicalInfo},
            ${JSON.stringify({
              'checkin.walk_ins_enabled': true,
              'checkin.walk_in_max_headcount': PARTY_CAP,
              'portal.feedback_enabled': true,
            })}::text::jsonb)
    returning id
  `;
  const concertId = Number(concert.id);

  const show = async (s: typeof REHEARSAL | typeof GALA, status: 'COMPLETED' | 'OPEN') => {
    const [row] = await sql<{ id: string }[]>`
      insert into shows (concert_id, name, status, capacity, starts_at, ends_at, doors_open_at,
                         venue_name, portal_unlock_mode)
      values (${concertId}, ${s.name}, ${status}, ${s.capacity},
              ${at(s.day, s.start).toISOString()}::timestamptz, ${at(s.day, s.end).toISOString()}::timestamptz,
              ${at(s.day, s.doors).toISOString()}::timestamptz, ${s.venue}, 'ON_ADMISSION')
      returning id
    `;
    return Number(row.id);
  };
  // The rehearsal is completed already, so the scheduler's auto-completion does
  // not queue a feedback blast the demo has no mailbox to send.
  const rehearsalId = await show(REHEARSAL, 'COMPLETED');
  const galaId = await show(GALA, 'OPEN');

  const segment = async (showId: number, values: {
    name: string; mode: 'PUBLIC' | 'PLAYER_INVITED'; capacity: number; order: number;
    baseQuota?: number; deadline?: Date; extras: 'AUTO_FCFS' | 'REVIEW'; autoApprove: boolean;
  }): Promise<Segment> => {
    const [row] = await sql<{ id: string }[]>`
      insert into show_segments (show_id, name, audience_mode, capacity, base_quota, base_claim_deadline,
                                 extras_policy, allow_partial_grant, max_tickets_per_response,
                                 display_order, auto_approve_clean)
      values (${showId}, ${values.name}, ${values.mode}, ${values.capacity}, ${values.baseQuota ?? null},
              ${values.deadline?.toISOString() ?? null}::timestamptz, ${values.extras},
              ${values.mode === 'PUBLIC'}, ${values.mode === 'PUBLIC' ? PARTY_CAP : null},
              ${values.order}, ${values.autoApprove})
      returning id
    `;
    return { id: Number(row.id), showId };
  };
  const rehearsalPublic = await segment(rehearsalId, {
    name: 'Public', mode: 'PUBLIC', capacity: REHEARSAL.capacity, order: 1, extras: 'AUTO_FCFS', autoApprove: true,
  });
  const galaPlayers = await segment(galaId, {
    name: 'Player invited', mode: 'PLAYER_INVITED', capacity: GALA.playerCapacity, order: 1,
    baseQuota: GALA.baseQuota, deadline: at(GALA.baseClaimDeadlineDay, '23:59'), extras: 'REVIEW', autoApprove: true,
  });
  const galaPublic = await segment(galaId, {
    name: 'Public', mode: 'PUBLIC', capacity: GALA.publicCapacity, order: 2, extras: 'AUTO_FCFS', autoApprove: true,
  });

  for (const showId of [rehearsalId, galaId]) {
    for (const usher of ushers) {
      await sql`insert into operator_show_assignments (user_id, show_id, assigned_by) values (${usher.id}, ${showId}, ${adminId})`;
    }
  }

  await ensureConcertTemplates(concertId);

  // Forms: the gala's two, and a feedback form per show.
  const form = async (values: {
    kind: 'PUBLIC' | 'PLAYER' | 'FEEDBACK'; segmentId?: number; showId?: number; title: string; slug: string;
    status: 'OPEN' | 'CLOSED'; opens?: Date; closes?: Date; schema: FormSchema; description?: string;
  }) => {
    const [row] = await sql<{ id: string }[]>`
      insert into registration_forms (segment_id, show_id, kind, title, slug, schema, schema_version, status,
                                      opens_at, closes_at, max_tickets_per_response, description_md,
                                      confirmation_message_md, one_response_per_identity)
      values (${values.segmentId ?? null}, ${values.showId ?? null}, ${values.kind}, ${values.title}, ${values.slug},
              ${JSON.stringify(values.schema)}::text::jsonb, 1, ${values.status},
              ${values.opens?.toISOString() ?? null}::timestamptz, ${values.closes?.toISOString() ?? null}::timestamptz,
              ${values.kind === 'PUBLIC' ? PARTY_CAP : null}, ${values.description ?? null},
              'Thank you — we have your registration, and your tickets will follow by email.',
              ${values.kind === 'PLAYER'})
      returning id
    `;
    return Number(row.id);
  };
  const galaPublicForm = await form({
    kind: 'PUBLIC', segmentId: galaPublic.id, title: 'Autumn Serenade — gala evening', slug: 'autumn-gala',
    status: 'OPEN', opens: at(-24, '10:00'), closes: at(GALA.day - 2, '23:59'), schema: blankFormSchema('PUBLIC'),
    description: 'Free admission, unreserved seating. Register everyone in your party, up to four people.',
  });
  const galaPlayerForm = await form({
    kind: 'PLAYER', segmentId: galaPlayers.id, title: 'Autumn Serenade — players’ guests', slug: 'autumn-gala-players',
    status: 'OPEN', opens: at(-24, '10:00'), closes: at(GALA.day - 2, '23:59'), schema: blankFormSchema('PLAYER'),
  });
  const feedbackSchema: FormSchema = {
    kind: 'FEEDBACK',
    blocks: [{
      id: 'feedback', type: 'CUSTOM', title: 'How was your afternoon?',
      fields: [
        { key: 'overall', label: 'How much did you enjoy it?', type: 'rating', required: true, system: false, scale: { min: 1, max: 5 } },
        { key: 'favourite', label: 'Which piece did you like best?', type: 'radio', required: false, system: false,
          options: [
            { value: 'overture', label: 'Overture — An Autumn Morning' },
            { value: 'serenade', label: 'Serenade for Strings' },
            { value: 'suite', label: 'Symphonic Suite — The Lake at Dusk' },
          ] },
        { key: 'comments', label: 'Anything else you would like to tell us?', type: 'textarea', required: false, system: false },
      ],
    }],
  } as FormSchema;
  const rehearsalFeedbackForm = await form({
    kind: 'FEEDBACK', showId: rehearsalId, title: 'Open rehearsal — feedback', slug: 'open-rehearsal-feedback',
    status: 'OPEN', schema: feedbackSchema,
  });
  await form({
    kind: 'FEEDBACK', showId: galaId, title: 'Gala evening — feedback', slug: 'autumn-gala-feedback',
    status: 'OPEN', schema: feedbackSchema,
  });

  // Players.
  const playerIds: { id: number; name: string; email: string }[] = [];
  for (let i = 0; i < PLAYERS; i++) {
    const p = person();
    const [instrument, section] = SECTIONS[i % SECTIONS.length];
    const [row] = await sql<{ id: string }[]>`
      insert into players (concert_id, full_name, email, instrument, section, invite_token, is_active)
      values (${concertId}, ${p.name}, ${p.email}, ${instrument}, ${section}, ${randomBytes(18).toString('base64url')}, true)
      returning id
    `;
    playerIds.push({ id: Number(row.id), name: p.name, email: p.email });
  }

  // ── The open rehearsal: imported, ticketed, admitted ────────────────────────
  const [batch] = await sql<{ id: string }[]>`
    insert into import_batches (show_id, segment_id, filename, uploaded_by, row_count, created_count,
                                skipped_count, error_count, status, created_at)
    values (${rehearsalId}, ${rehearsalPublic.id}, 'open-rehearsal-registrations.csv', ${adminId},
            0, 0, 0, 0, 'COMMITTED', ${at(REHEARSAL.day - 12, '20:15').toISOString()}::timestamptz)
    returning id
  `;
  const rehearsalParties: number[] = [];
  let rehearsalSeats = 0;
  while (rehearsalSeats < 150) {
    const contact = person();
    const size = partySize();
    rehearsalSeats += size;
    rehearsalParties.push(await createParty({
      segment: rehearsalPublic, source: 'IMPORT', importBatchId: Number(batch.id), contact,
      seats: publicSeats(contact, size, 0.1),
      requestedAt: at(REHEARSAL.day - between(13, 26), `${between(8, 22)}:${String(between(0, 59)).padStart(2, '0')}`),
    }));
  }
  await sql`
    update import_batches set row_count = ${rehearsalParties.length + 3}, created_count = ${rehearsalParties.length},
           skipped_count = 2, error_count = 1
     where id = ${batch.id}
  `;
  await approve(rehearsalParties, adminId, at(REHEARSAL.day - 12, '20:30'));
  await sql`update registrations set email_verified_at = requested_at where id = any(${rehearsalParties}::bigint[])`;
  await issueTickets({ concertId, segmentId: rehearsalPublic.id });
  await blast(rehearsalPublic.id, 'public_ticket', adminId);
  await dispatchAll();
  await backdateDelivery(rehearsalParties, at(REHEARSAL.day - 11, '19:00'), at(REHEARSAL.day - 11, '19:40'));

  // Door: most seats admitted across the doors window, by three ushers; some no-shows.
  const rehearsalSeatsRows = await sql<{ id: string }[]>`
    select a.id from attendees a where a.segment_id = ${rehearsalPublic.id} and a.status = 'CONFIRMED' order by a.id
  `;
  const doors = at(REHEARSAL.day, REHEARSAL.doors);
  let admitted = 0;
  for (const row of rehearsalSeatsRows) {
    if (random() < 0.13) continue; // a no-show
    const minute = Math.min(55, Math.max(-5, Math.round(18 + (random() + random() + random() - 1.5) * 22)));
    const scannedAt = new Date(doors.getTime() + minute * 60_000 + between(0, 59) * 1000);
    const usher = pick(ushers);
    await sql`
      insert into check_ins (attendee_id, show_id, operator_id, device_id, scanned_at, synced_at, source)
      values (${row.id}, ${rehearsalId}, ${usher.id}, ${`demo-${usher.name.toLowerCase().replace(/\W+/g, '-')}`},
              ${scannedAt.toISOString()}::timestamptz, ${minutesAfter(scannedAt, random() < 0.2 ? 6 : 0).toISOString()}::timestamptz,
              ${random() < 0.2 ? 'OFFLINE_SYNC' : 'ONLINE'})
    `;
    admitted++;
  }
  for (const [minutes, headcount, label] of [[8, 2, 'Friends of a player'], [21, 1, null], [27, 3, null], [34, 2, 'Family, no booking'], [41, 1, null]] as const) {
    const usher = pick(ushers);
    await recordWalkIn(
      { clientId: randomUUID(), segmentId: rehearsalPublic.id, headcount, label, deviceId: `demo-${usher.name.toLowerCase()}`, admittedAt: minutesAfter(doors, minutes).toISOString() },
      { showId: rehearsalId, operatorId: usher.id },
    );
  }

  // Feedback from some of those admitted.
  const answered = await sql<{ id: string; registration_id: string }[]>`
    select a.id, a.registration_id from attendees a
     where a.segment_id = ${rehearsalPublic.id}
       and exists (select 1 from check_ins c where c.attendee_id = a.id)
     order by a.id
  `;
  const COMMENTS = [
    'Lovely to hear the orchestra up close. The cellos were wonderful.',
    'More of these open rehearsals, please!',
    'The scanning at the door was very quick.',
    'Could the programme be printed in a larger font?',
    'Brought my children for the first time; they loved the percussion.',
    '',
  ];
  for (const row of answered.filter(() => random() < 0.3)) {
    const submitted = at(REHEARSAL.day + between(0, 2), `${between(17, 22)}:${String(between(0, 59)).padStart(2, '0')}`);
    await sql`
      insert into feedback_responses (form_id, attendee_id, show_id, answers, form_schema, submitted_at)
      values (${rehearsalFeedbackForm}, ${row.id}, ${rehearsalId},
              ${JSON.stringify({ overall: pick([3, 4, 4, 5, 5, 5]), favourite: pick(['overture', 'serenade', 'suite']), comments: pick(COMMENTS) })}::text::jsonb,
              ${JSON.stringify(feedbackSchema)}::text::jsonb, ${submitted.toISOString()}::timestamptz)
      on conflict do nothing
    `;
  }

  // ── The gala: players' guests ───────────────────────────────────────────────
  const playerParties: { registrationId: number; extras: number }[] = [];
  for (const player of playerIds.slice(0, 46)) {
    const extras = random() < 0.2 ? between(1, 2) : 0;
    const seats: SeatRequest[] = [{ fullName: person().name, email: null, allocationType: 'BASE' }];
    for (let i = 0; i < extras; i++) seats.push({ fullName: random() < 0.3 ? null : person().name, email: null, allocationType: 'EXTRA' });
    const registrationId = await createParty({
      segment: galaPlayers, source: 'FORM', formId: galaPlayerForm, playerId: player.id,
      contact: { name: player.name, email: player.email, phone: null }, seats,
      requestedAt: at(-between(1, 22), `${between(8, 23)}:${String(between(0, 59)).padStart(2, '0')}`),
    });
    playerParties.push({ registrationId, extras });
  }

  // ── The gala: the public ────────────────────────────────────────────────────
  const publicParties: number[] = [];
  for (let i = 0; i < 74; i++) {
    const contact = person();
    publicParties.push(await createParty({
      segment: galaPublic, source: 'FORM', formId: galaPublicForm, contact,
      seats: publicSeats(contact, partySize(), 0.12),
      requestedAt: at(-between(0, 22), `${between(7, 23)}:${String(between(0, 59)).padStart(2, '0')}`),
      unverified: i >= 70,
    }));
  }

  // Two parties that are probably one: same person, two submissions a day apart.
  const twin = person();
  const twinA = await createParty({
    segment: galaPublic, source: 'FORM', formId: galaPublicForm, contact: twin,
    seats: publicSeats(twin, 2, 0), requestedAt: at(-3, '21:04'),
  });
  const twinB = await createParty({
    segment: galaPublic, source: 'FORM', formId: galaPublicForm,
    contact: { ...twin, email: twin.email.replace('@', '+gala@') },
    seats: publicSeats(twin, 3, 0), requestedAt: at(-2, '09:47'),
  });
  // An address with a typo the checker caught.
  const typo = person();
  const typoParty = await createParty({
    segment: galaPublic, source: 'FORM', formId: galaPublicForm,
    contact: { ...typo, email: typo.email.replace(/@example\.(com|org|net)$/, '@example.con') },
    seats: publicSeats(typo, 2, 0), requestedAt: at(-1, '13:20'),
    emailIssue: 'The domain looks mistyped: did you mean example.com?',
  });
  void twinA; void twinB; void typoParty;

  // Review: most parties approved; the last few days' wait, and the flagged ones wait.
  const [{ cutoff }] = [{ cutoff: at(-2, '00:00') }];
  const clean = await sql<{ registration_id: string }[]>`
    select registration_id from party_pipeline
     where show_id = ${galaId} and requested_at < ${cutoff.toISOString()}::timestamptz
       and cardinality(flags) - (case when 'UNNAMED_GUESTS' = any(flags) then 1 else 0 end) = 0
  `;
  await approve(clean.map((r) => Number(r.registration_id)), adminId, at(-2, '10:00'));
  // Players' extra seats: some granted, the rest still waiting for review.
  for (const party of playerParties.filter((p) => p.extras > 0)) {
    if (random() < 0.5) {
      const pending = await sql<{ id: string }[]>`
        select id from attendees where registration_id = ${party.registrationId} and status = 'PENDING_REVIEW'
      `;
      await promoteSeats(galaPlayers.id, pending.map((p) => Number(p.id)));
    }
  }

  // Tickets: most approved parties ticketed and sent; some issued and waiting; some not yet issued.
  const ready = await sql<{ registration_id: string; segment_id: string }[]>`
    select registration_id, segment_id from party_pipeline
     where show_id = ${galaId} and stage = 'NEEDS_TICKETS' order by registration_id
  `;
  const toSend = ready.filter(() => random() < 0.72).map((r) => Number(r.registration_id));
  const toIssueOnly = ready
    .map((r) => Number(r.registration_id))
    .filter((id) => !toSend.includes(id))
    .filter(() => random() < 0.5);
  await issueTickets({ concertId, attendeeIds: await attendeeIds(toSend) });
  await blast(galaPublic.id, 'public_ticket', adminId);
  await blast(galaPlayers.id, 'player_confirmation', adminId);
  await dispatchAll();
  await backdateDelivery(toSend, at(-2, '11:00'), at(-1, '18:00'));
  await issueTickets({ concertId, attendeeIds: await attendeeIds(toIssueOnly) });

  // ── Things a person must look at ────────────────────────────────────────────
  const sentPublic = await sql<{ registration_id: string; contact_email: string; contact_name: string }[]>`
    select p.registration_id, p.contact_email, p.contact_name from party_pipeline p
     where p.segment_id = ${galaPublic.id} and p.stage = 'SENT' order by p.registration_id
  `;
  const [bounced, replyA, replyB, changed] = sentPublic.slice(-4);

  // A bounce: the ticket email came back from a mailbox that does not exist.
  {
    const [outbox] = await sql<{ id: string; message_id: string | null; sent_at: string }[]>`
      select id, message_id, sent_at from email_outbox
       where registration_id = ${bounced.registration_id} and purpose = 'TICKETS' order by id desc limit 1
    `;
    const bouncedAt = minutesAfter(outbox.sent_at, 4);
    await sql`
      update email_outbox set bounced_at = ${bouncedAt.toISOString()}::timestamptz, bounce_code = '550 5.1.1',
             bounce_detail = 'The email account that you tried to reach does not exist.'
       where id = ${outbox.id}
    `;
    const threadId = await thread(Number(bounced.registration_id));
    await sql`
      insert into email_messages (thread_id, direction, outbox_id, from_email, from_name, to_email, subject, text,
                                  is_bounce, message_at, folder, in_reply_to)
      values (${threadId}, 'INBOUND', ${outbox.id}, 'mailer-daemon@example.net', 'Mail Delivery Subsystem',
              'tickets@example.org', 'Delivery Status Notification (Failure)',
              ${`Your message wasn't delivered to ${bounced.contact_email} because the address couldn't be found.`},
              true, ${bouncedAt.toISOString()}::timestamptz, 'INBOX', ${outbox.message_id})
    `;
  }

  // Two replies waiting for an answer.
  for (const [party, subject, text] of [
    [replyA, 'Re: Your tickets for Autumn Serenade', 'Hello! Is there step-free access to the Main Hall? My father uses a wheelchair. Thank you.'],
    [replyB, 'Re: Your tickets for Autumn Serenade', 'Hi, one of our party can no longer come — should I do anything with their ticket?'],
  ] as const) {
    const [outbox] = await sql<{ id: string; message_id: string | null; sent_at: string }[]>`
      select id, message_id, sent_at from email_outbox
       where registration_id = ${party.registration_id} and purpose = 'TICKETS' order by id desc limit 1
    `;
    const threadId = await thread(Number(party.registration_id));
    const repliedAt = minutesAfter(outbox.sent_at, between(90, 1400));
    await sql`
      insert into email_messages (thread_id, direction, from_email, from_name, to_email, subject, text,
                                  is_bounce, message_at, folder, in_reply_to, message_id)
      values (${threadId}, 'INBOUND', ${party.contact_email}, ${party.contact_name}, 'tickets@example.org',
              ${subject}, ${text}, false, ${repliedAt.toISOString()}::timestamptz, 'INBOX', ${outbox.message_id},
              ${`<${createHash('sha1').update(String(party.registration_id)).digest('hex')}@example.net>`})
    `;
    await sql`update email_threads set last_message_at = ${repliedAt.toISOString()}::timestamptz where id = ${threadId}`;
  }

  // A guest renamed after their ticket went out: the ticket needs reissuing.
  await sql`
    update attendees set full_name = full_name || ' Jr', needs_reissue = true
     where id = (select min(id) from attendees where registration_id = ${changed.registration_id})
  `;

  // A ticket email that failed outright, and was not yet retried.
  {
    const [party] = await sql<{ registration_id: string; contact_email: string; contact_name: string }[]>`
      select p.registration_id, p.contact_email, p.contact_name from party_pipeline p
       where p.segment_id = ${galaPublic.id} and p.stage = 'READY_TO_SEND' order by p.registration_id limit 1
    `;
    if (party) {
      await sql`
        insert into email_outbox (registration_id, template_key, purpose, to_email, to_name, subject, body_md, status,
                                  attempts, last_error, created_at, updated_at)
        values (${party.registration_id}, 'public_ticket', 'TICKETS', ${party.contact_email}, ${party.contact_name},
                'Your tickets for Autumn Serenade', 'Your tickets are attached.', 'FAILED', 3,
                'Greeting never received', ${at(-1, '19:02').toISOString()}::timestamptz, ${at(-1, '19:20').toISOString()}::timestamptz)
      `;
    }
  }

  // ── Closing touches ─────────────────────────────────────────────────────────
  const pdfPath = await putAsset({ concertId, contentType: 'application/pdf', bytes: await bookletPdf() });
  await sql`
    insert into booklets (concert_id, title, pdf_path, published, created_at)
    values (${concertId}, 'Autumn Serenade — programme', ${pdfPath}, true, ${at(-12, '09:00').toISOString()}::timestamptz)
  `;

  // A scheduler heartbeat, so Home reads as a running install.
  await sql`
    insert into scheduler_heartbeat (source, started_at, finished_at, report)
    values ('pg_cron', now() - interval '2 minutes', now() - interval '2 minutes' + interval '3 seconds',
            ${JSON.stringify({ source: 'pg_cron', demo: true })}::text::jsonb)
  `;

  const [summary] = await sql<{ parties: number; seats: number; admitted: number }[]>`
    select count(*)::int as parties, coalesce(sum(live_seats), 0)::int as seats, coalesce(sum(admitted_seats), 0)::int as admitted
      from party_pipeline where concert_id = ${concertId}
  `;
  const stages = await sql<{ stage: string; n: number }[]>`
    select stage, count(*)::int as n from party_pipeline where concert_id = ${concertId} group by stage order by stage
  `;
  console.log(`Seeded "${CONCERT.name}": ${summary.parties} parties, ${summary.seats} seats, ${summary.admitted} admitted (${admitted} scans).`);
  console.log('Stages:', stages.map((s) => `${s.stage} ${s.n}`).join(', '));
  console.log('Sign in as admin@example.org (admin) or visitor@example.org (viewer).');
  await sql.end();
}

async function thread(registrationId: number): Promise<number> {
  const [row] = await sql<{ id: string }[]>`
    insert into email_threads (registration_id) values (${registrationId})
    on conflict (registration_id) do update set deleted_at = null, updated_at = now()
    returning id
  `;
  return Number(row.id);
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await sql.end();
  process.exit(1);
});
