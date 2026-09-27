-- 0203 — REPLY_WAITING reads "unhandled", not "newest" (module `U`, spec/v3.md §21.2, §26.5).
--
-- 0200 raised REPLY_WAITING when the newest message in a party's thread was an
-- unhandled reply. The inbox also stores bounces in the thread, so a bounce
-- arriving after an unanswered question hid it: the party lost the flag while
-- the Inbox still listed the question as waiting (U's QA, finding 3).
--
-- Since U, `handled_at` is the whole fact. Replying from the record, a reply
-- written in Gmail and read back from Sent Mail, and Mark handled each handle
-- every reply up to the one answered, and never a later one. So the flag is
-- simply "some reply is unhandled", which is what the Inbox counts.
--
-- The rest of the view is 0200's, unchanged: `create or replace` keeps its
-- columns, their order and types, its grants and `security_invoker`.
-- Additive (`modules-v3.md` §3.3): one view body replaced.

create or replace view party_pipeline with (security_invoker = true) as
with seats as (
  select
    a.registration_id,
    count(*) filter (where a.status <> 'CANCELLED')::int as live_seats,
    count(*) filter (where a.status = 'CANCELLED')::int as cancelled_seats,
    count(*) filter (where a.status = 'CONFIRMED')::int as confirmed_seats,
    count(*) filter (where a.status = 'PENDING_REVIEW')::int as pending_seats,
    count(*) filter (where a.status = 'WAITLIST')::int as waitlisted_seats,
    count(*) filter (where a.status = 'CONFIRMED'
                       and a.qr_token is not null
                       and a.ticket_template_id is not null)::int as issued_seats,
    count(*) filter (where a.status = 'CONFIRMED'
                       and a.ticket_sent_at is not null)::int as delivered_seats,
    count(*) filter (where a.status <> 'CANCELLED'
                       and exists (select 1 from check_ins c
                                    where c.attendee_id = a.id
                                      and c.reverted_at is null))::int as admitted_seats,
    bool_or(a.status <> 'CANCELLED' and a.needs_reissue) as any_needs_reissue,
    bool_or(a.status <> 'CANCELLED' and a.name_source = 'PLACEHOLDER') as any_placeholder,
    bool_or(a.status = 'CONFIRMED' and a.over_capacity_at is not null) as any_over_capacity
  from attendees a
  where a.deleted_at is null
  group by a.registration_id
),
base as (
  select
    r.id as registration_id,
    s.concert_id,
    r.show_id,
    r.segment_id,
    g.audience_mode,
    r.player_id,
    r.source,
    r.round_label,
    r.status as registration_status,
    r.contact_name,
    r.contact_email,
    r.contact_phone,
    r.requested_at,
    r.approved_at,
    r.email_verified_at,
    r.created_at,
    r.updated_at,
    coalesce(x.live_seats, 0) as live_seats,
    coalesce(x.cancelled_seats, 0) as cancelled_seats,
    coalesce(x.confirmed_seats, 0) as confirmed_seats,
    coalesce(x.pending_seats, 0) as pending_seats,
    coalesce(x.waitlisted_seats, 0) as waitlisted_seats,
    coalesce(x.issued_seats, 0) as issued_seats,
    coalesce(x.delivered_seats, 0) as delivered_seats,
    coalesce(x.admitted_seats, 0) as admitted_seats,

    -- BOUNCED: the newest ticket-bearing message that went out to the address
    -- the party has *now* bounced. Fixing the address, or a later send to it
    -- that did not bounce, clears the flag by construction.
    coalesce((
      select o.bounced_at is not null
        from email_outbox o
       where o.registration_id = r.id
         and o.deleted_at is null
         -- Ticket-bearing: TICKETS, and the granted half of EXTRAS_DECISION
         -- (§24.2). A bounced decline carried no ticket.
         and (o.purpose = 'TICKETS'
              or (o.purpose = 'EXTRAS_DECISION' and o.template_key = 'extras_granted'))
         and o.sent_at is not null
         and o.to_email = r.contact_email
       order by o.sent_at desc, o.id desc
       limit 1), false) as flag_bounced,

    exists (
      select 1 from email_outbox f
       where f.registration_id = r.id
         and f.deleted_at is null
         and f.status = 'FAILED'
         and not exists (
           select 1 from email_outbox later
            where later.registration_id = r.id
              and later.deleted_at is null
              and later.purpose = f.purpose
              and later.status = 'SENT'
              and later.id > f.id)
         -- A failed ticket message whose tickets all reached the party anyway —
         -- by hand, or in another message — is history, not a problem.
         and not (f.purpose in ('TICKETS', 'EXTRAS_DECISION')
                  and coalesce(x.confirmed_seats, 0) > 0
                  and x.delivered_seats >= x.confirmed_seats)) as flag_send_failed,

    (r.email_issue is not null and r.email_issue_accepted_at is null) as flag_suspicious_address,
    coalesce(x.any_needs_reissue, false) as flag_changed_after_send,

    -- A candidate is "a pair of live parties" (§25.5): once either side is
    -- deleted or merged away, the survivor is no longer anyone's duplicate.
    exists (
      select 1 from duplicate_candidates d
        join registrations other
          on other.id = case when d.registration_a_id = r.id
                             then d.registration_b_id else d.registration_a_id end
       where d.status = 'OPEN'
         and d.deleted_at is null
         and r.id in (d.registration_a_id, d.registration_b_id)
         and other.deleted_at is null) as flag_possible_duplicate,

    coalesce(x.any_placeholder, false) as flag_unnamed_guests,

    -- REPLY_WAITING (0203): a reply from them that nobody has answered or
    -- marked handled (§26.5). Answering handles every reply up to the one
    -- answered, so "unhandled" is the whole fact; whatever arrived after it —
    -- a bounce, a ticket resend — no longer hides it.
    exists (
      select 1
        from email_threads t
        join email_messages m on m.thread_id = t.id and m.deleted_at is null
       where t.registration_id = r.id
         and t.deleted_at is null
         and m.direction = 'INBOUND'
         and not m.is_bounce
         and m.handled_at is null) as flag_reply_waiting,

    coalesce(x.any_over_capacity, false) as flag_over_capacity,

    (r.verification_token is not null and r.email_verified_at is null) as unverified
  from registrations r
  join shows s on s.id = r.show_id
  join show_segments g on g.id = r.segment_id
  left join seats x on x.registration_id = r.id
  where r.deleted_at is null
)
select
  b.registration_id,
  b.concert_id,
  b.show_id,
  b.segment_id,
  b.audience_mode,
  b.player_id,
  b.source,
  b.round_label,
  b.registration_status,
  b.contact_name,
  b.contact_email,
  b.contact_phone,
  b.requested_at,
  b.approved_at,
  b.email_verified_at,
  b.created_at,
  b.updated_at,
  case
    when b.live_seats = 0 and (b.cancelled_seats > 0 or b.registration_status = 'CANCELLED')
      then 'CANCELLED'
    when b.live_seats = 0 then null
    when b.approved_at is null or b.pending_seats > 0 then 'NEEDS_REVIEW'
    when b.confirmed_seats = 0 and b.waitlisted_seats > 0 then 'WAITLISTED'
    when b.unverified then 'UNVERIFIED'
    when b.issued_seats < b.confirmed_seats then 'NEEDS_TICKETS'
    when b.delivered_seats < b.confirmed_seats then 'READY_TO_SEND'
    when b.admitted_seats > 0 then 'ADMITTED'
    else 'SENT'
  end as stage,
  array_remove(array[
    case when b.flag_bounced then 'BOUNCED' end,
    case when b.flag_send_failed then 'SEND_FAILED' end,
    case when b.flag_suspicious_address then 'SUSPICIOUS_ADDRESS' end,
    case when b.flag_changed_after_send then 'CHANGED_AFTER_SEND' end,
    case when b.flag_possible_duplicate then 'POSSIBLE_DUPLICATE' end,
    case when b.flag_unnamed_guests then 'UNNAMED_GUESTS' end,
    case when b.flag_reply_waiting then 'REPLY_WAITING' end,
    case when b.flag_over_capacity then 'OVER_CAPACITY' end
  ], null) as flags,
  b.flag_bounced,
  b.flag_send_failed,
  b.flag_suspicious_address,
  b.flag_changed_after_send,
  b.flag_possible_duplicate,
  b.flag_unnamed_guests,
  b.flag_reply_waiting,
  b.flag_over_capacity,
  b.live_seats,
  b.confirmed_seats,
  b.pending_seats,
  b.waitlisted_seats,
  b.cancelled_seats,
  b.issued_seats,
  b.delivered_seats,
  b.admitted_seats
from base b;
