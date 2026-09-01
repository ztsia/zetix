*Transport, the outbox, templates, and what makes a repeat blast safe.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

---

# 11. Email

## 11.1 Transport

**Gmail SMTP over `nodemailer`, sent from a Vercel Node.js function.** This works — the widely-repeated
"serverless blocks SMTP" claim is about **port 25 only**. Ports 465 and 587 are not blocked; Vercel
functions run on AWS Lambda, which has unrestricted outbound on both.

```
host: smtp.gmail.com   port: 465   secure: true
auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }   // app password requires 2FA
```

Three things must be right or it fails in ways that look like a platform problem:

1. **`export const runtime = 'nodejs'`** on the dispatch route. The Edge runtime has no TCP sockets.
2. **`export const maxDuration = 60`** — Vercel Hobby's ceiling, against a 10s default. Each send costs
   roughly 1–2s including the SMTP handshake, so a batch of ~20–25 fits comfortably. This is what
   `email.max_per_dispatch` is sized against.
3. **Assume no connection reuse** between invocations. Open, send the batch, close.

**Volume scales with registrations, not seats.** Email goes to *registrants*: one message per player
carrying several ticket PDFs, one per public party. A show typically generates emails numbering in the
low hundreds at most, well inside a free Gmail account's 500/day even across two registration rounds.
Expected figures for the current concert are in `context.md`.

The outbox enforces `email.max_per_day` regardless, so exceeding a provider cap defers the remainder to
the next day rather than failing.

Transport sits behind one `MailTransport` interface so an alternative is an adapter file, not a
rewrite. Documented alternatives, in case Gmail becomes a constraint:

| Alternative | When |
|---|---|
| Brevo HTTP API (300/day) | If SMTP proves flaky in the full-volume dry run, or deliverability suffers |
| Resend HTTP API (3000/mo, 100/day) | Secondary failover; the daily cap is the binding limit |
| Supabase Edge Function + `denomailer` | Works (Deno runtime allows TCP), but splits the dispatcher across two platforms for no gain |
| GitHub Actions + `nodemailer` | Moves dispatch off Vercel entirely; only worth it if function limits become the bottleneck |

Verify the sender address before the first real send. Deliverability problems present as silent
spam-foldering, not as errors, so send test messages to Gmail, Outlook and one university/corporate
address and confirm all three land in the inbox.

## 11.2 Outbox pattern — no always-on worker

1. Anything that should send email writes `email_outbox` rows as `DRAFT`, with `subject` and `body_md`
   already **rendered** for that recipient (§11.5).
2. Admin opens **Email → Outbox**, reviews and edits the batch, and confirms — which moves the rows to
   `QUEUED` — then clicks **Send**.
3. The UI calls `POST /api/outbox/dispatch` repeatedly. Each call claims up to `email.max_per_dispatch`
   `QUEUED` rows (`FOR UPDATE SKIP LOCKED`), sends with `email.inter_message_delay_ms` between
   messages, commits per message, and returns progress. The UI shows a progress bar until the queue
   drains or the daily cap is hit. `DRAFT` rows are never dispatched — only a human moves a row out of
   `DRAFT`.
4. A daily cron hits the same endpoint as a safety net. Add it to `vercel.json`
   **when the dispatch route ships, not before** — a cron pointing at a route
   that does not exist yet returns 404 daily and trains everyone to ignore the
   one signal that would tell them dispatching had actually broken.

This is the one-click blast model: no persistent process, and it survives function timeouts because
progress is committed per message. Failures back off, retry to `email.max_attempts`, then surface in
admin with `last_error`.

## 11.3 Templates

| Key | Trigger | To |
|---|---|---|
| `player_confirmation` | Player form submitted | Player — summary + all guest tickets attached |
| `public_verify` | Public registration created | Registrant — verification link only |
| `public_ticket` | Public registration verified | Registrant — party's tickets attached |
| `extras_granted` | Extras review committed | Registrant — with tickets |
| `extras_declined` | Extras review committed | Registrant |
| `registration_cancelled` | Admin cancels | Registrant |
| `reminder` | Admin-triggered, pre-show | All confirmed |
| `player_notes_digest` | Admin-triggered, post-show | Player — notes addressed to them |

Markdown + `{{ }}` placeholders stored in the DB, editable with live preview and a documented token
list. Plain-text alternative auto-generated. Tickets attach as one PDF per attendee, named
`{show}-{name}-{ticket_code}.pdf`; past `email.merge_attachments_above`, merge into one PDF to stay
under `email.max_attachment_mb` (Gmail's hard ceiling is 25MB).

Every ticket email also carries the portal link as secondary text — but the **PDF is the ticket** (`v2.md` §13.1).

## 11.4 Repeat blasts must never double-send

Registration arrives in rounds. Round 1 closes, tickets go out; leftover seats reopen registration;
round 2 closes, and a second blast must reach **only the new people**. Someone who already has their
ticket must not receive it twice, and nobody must be silently skipped.

Three mechanisms, all required:

1. **`attendees.ticket_sent_at` is the dedup key.** Set only on confirmed delivery — a successful send,
   or an admin marking it delivered by hand (§11.5) — never on queueing. Any attendee with a non-null
   value is excluded from future blasts.
2. **Queueing is a filtered insert**, not a loop in application code. It selects **registrations that
   still have at least one undelivered seat**, because a message is addressed to a registrant and
   carries every outstanding ticket in that party:
   ```sql
   insert into email_outbox (registration_id, template_key, to_email, to_name, ...)
   select r.id, 'public_ticket', r.contact_email, r.contact_name, ...
     from registrations r
    where r.segment_id = $1
      and r.status = 'CONFIRMED'
      and exists (
          select 1 from attendees a
           where a.registration_id = r.id
             and a.status = 'CONFIRMED'
             and a.ticket_sent_at is null
             and a.deleted_at is null)
   on conflict do nothing;
   ```
3. **The partial unique index** on `(registration_id, template_key) where status in
   ('DRAFT','QUEUED','SENDING')` (`domain.md` §5.1) makes the `on conflict do nothing` meaningful. Without it,
   clicking Send twice queues everything twice.
4. **A successful send stamps every attendee it carried.** In the same transaction that marks the
   outbox row `SENT`, set `ticket_sent_at = now()` and `ticket_sent_source = 'EMAIL'` on exactly the
   attendees whose PDFs were attached. Partial delivery does not exist: either the message sent and all
   its tickets are delivered, or it failed and none are.

**Why the key is the registration, not the attendee.** Every ticket-bearing email in §11.3 goes to a
registrant. Guest emails are optional (`v2.md` §8.1), so many attendees have no address at all — a player
receives one message with four PDFs to forward. Keying the outbox on a nullable `attendee_id` would
also defeat the index outright: in Postgres two rows with `attendee_id IS NULL` do not conflict, so
`on conflict do nothing` would do nothing for exactly the player-invited audience, and a second click
would queue every player confirmation twice.

**The added-guest case works correctly.** If an admin adds a fourth guest to a party whose first three
tickets are already sent, that attendee's `ticket_sent_at` is null, the `exists` clause selects the
registration again, and the next blast re-sends the party's message with all four PDFs. That is the
right outcome: the party gets one email containing everything they hold.

Together these make the blast **idempotent**: pressing it repeatedly is harmless. This matters because
an admin who is unsure whether the first click registered will click again.

**The blast screen must show the split before committing:**

```
Player invited · Round 2
   84 confirmed attendees
   62 already sent          (excluded)
   22 pending               ← this blast
    0 failed, retryable
```

Nothing is queued until the admin confirms against those numbers.

**Explicit resend** is a separate action — select specific attendees, "Resend ticket", which clears
`ticket_sent_at` for exactly those rows and queues them. Used when someone deletes their email. It is
never the default path, and never operates on a whole segment at once without a typed confirmation.

**Round attribution.** `registrations.round_label` is copied from the form that captured the
registration, so the blast screen, exports and reports can group by round without inferring it from
timestamps.

## 11.5 Review and edit before sending

Nothing leaves the system that a person has not looked at. Preparing a blast **renders** each
recipient's subject and body — merge fields resolved against their real data — and stores the result on
the outbox row as `DRAFT`. The admin then sees the actual messages, not a template and a promise.

- **Edit the template** — re-renders every `DRAFT` row in the batch. This is the normal path: fix the
  wording once, see all 80 messages update.
- **Edit one message** — overwrite `subject` / `body_md` on a single row, for the one recipient who
  needs a note about wheelchair access. Marked as edited so it survives a subsequent template
  re-render.
- **Preview against a real recipient**, never a lorem stub (`ref.md` §6), with a "longest name" and a
  "no player linked" case in the picker — template bugs are almost always data-shape bugs.
- **Confirm** moves the batch `DRAFT → QUEUED`. Only then can the dispatcher touch it.

The dispatcher sends `subject` and `body_md` verbatim. What was reviewed is what goes out; a later
template edit cannot change a message already reviewed.

## 11.6 Marking a ticket delivered by hand

Delivery sometimes happens outside the system: an admin forwards a PDF from their own mailbox, hands
someone a printout at a rehearsal, or reaches a registrant whose address bounced through some other
channel. Without a way to record that, those attendees keep `ticket_sent_at = NULL` and reappear in the
pending bucket of every future blast for ever.

So: **"Mark as delivered"** is an explicit admin action on selected attendees. It sets `ticket_sent_at`
and `ticket_sent_source = 'MANUAL'`, requires a short reason, and writes to `audit_log`. It sends
nothing. It is the exact inverse of "Resend ticket", and the two together mean the pending count on the
blast screen is always a real, actionable number rather than a residue of edge cases.
