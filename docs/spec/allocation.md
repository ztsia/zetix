*Capacity, quotas, the extras pool and `claim_seats()`. The correctness core.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `F1` (the engine) and `B` (the extras review screen).
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 7. Capacity and allocation engine

The only genuinely non-trivial logic in the system. Specify precisely, test hard.

## 7.1 Segments own the allocation; shows own the hall

A show is a physical event with one door and one total capacity. Within it, **segments** carve that
capacity into blocks with different audience models. A show may have a single segment, or several — for
example a public block and a player-invited block sharing one hall on one night. This is the normal
case, not an exception.

Every formula below is evaluated **per segment**, never per show. The show-level check is only that the
segments fit inside the hall.

Concrete segment configurations for the current concert are in `context.md`.

## 7.2 Definitions per segment

```
sellable        = segment.capacity
confirmed       = count(attendees WHERE segment_id = G AND status = 'CONFIRMED')
base_claimed(p) = count(attendees for player p in G, allocation_type='BASE', status='CONFIRMED')
unclaimed_base  = Σ over active players of max(0, base_quota(p,G) - base_claimed(p,G))
open_seats      = sellable - confirmed

extras_pool = max(0, open_seats - unclaimed_base)   -- before base_claim_deadline
extras_pool = max(0, open_seats)                    -- after base_claim_deadline
```

For a `PUBLIC` segment there are no players, so `unclaimed_base = 0` and `extras_pool = open_seats`.

The `max(0, …)` is not decoration. Admin overrides (§7.6) can push `confirmed` past `sellable`, at
which point `open_seats` is negative; the pool must read zero and the screen must say *"full, N over"*,
never a negative number that some later arithmetic treats as capacity.

`capacity` is **show-level** — it describes how many bodies fit in the room, and blocks except under
explicit admin override (§7.6). Seats belonging to no segment are held seats and are never allocated.

## 7.3 Worked example

**Illustrative numbers, not any real concert's** — see `context.md` for those. A player segment of 120
seats with 30 active players at a base quota of 3:

| Moment | confirmed | unclaimed_base | open_seats | extras_pool |
|---|---|---|---|---|
| Registration opens | 0 | 90 | 120 | **30** |
| 50 base seats claimed | 50 | 40 | 70 | **30** |
| Deadline passes, 72 base claimed | 72 | 18 (released) | 48 | **48** |

The pool starts at capacity minus what players are collectively entitled to, and grows by exactly the
unclaimed remainder when the deadline passes. Before the deadline, extras can never consume a seat a
player is still entitled to.

Where base quota × players exactly equals segment capacity, the pool is zero until the deadline. That
is correct, not a bug: extras are precisely the seats players did not take.

These three rows are the primary test case for `claim_seats()`. Write them as unit tests first.

## 7.4 Grant rules

**BASE seats** are granted immediately whenever `base_claimed(p) < base_quota(p)` and `open_seats > 0`
in that segment. A player is never refused their base allocation before the deadline.

**Base entitlement may not exceed segment capacity.** The system blocks any save where

```
base_quota × count(active players in segment) > segment.capacity
```

The check runs on **all three** mutations that can breach it — editing segment capacity down, editing
base quota up, and adding or reactivating a player — not just on the segment form. Blocking only one of
them leaves the other two as silent routes to an oversubscribed segment.

The error names the numbers and the shortfall: *"82 active players × 2 base = 164 seats, but the
segment holds 100. Reduce the quota to 1, raise capacity to 164, or deactivate 32 players."*

**There is no opt-out toggle.** The promise the system makes — every active player gets the base
allocation they were told they have — is one it should simply keep. An organiser who wants to overbook
on the expectation that some players never claim already has the honest lever: lower the quota, or raise
the segment's capacity and let the extras pool absorb the difference. A "knowingly oversubscribe" flag
buys nothing that those two do not, and costs a code path, a UI, a warning banner and a permanent
ambiguity about which promise is in force.

**BASE seats are granted seat by seat, not whole-party.** A player owed two seats who asks for two
when one remains gets that one confirmed and the other waitlisted. The whole-party rule below is
written about *extras* requests — where the pool decides an ordering between competing strangers and
cutting a party in half is a worse answer than making it wait. A player's base allocation is a promise
to that player rather than a place in a queue, so giving them as much of it as exists is right.

**EXTRA seats** follow the segment's `extras_policy`:

- **`REVIEW` (default for player segments).** Requests are created as `PENDING_REVIEW` with
  `requested_at` set, consuming no seats. After the deadline the admin grants in batch (§7.5).
- **`AUTO_FCFS` (default for public segments).** Granted at submission if the pool has room,
  atomically. With `allow_partial_grant`, the remainder becomes `WAITLIST`.

The pool sizes the **preselection**, not the admin's authority. Under `REVIEW` the admin may tick past
it (§7.5); the system warns, requires a typed confirmation once the segment or the hall would be
exceeded, and records it. Automatic rules decide the default; a person decides the exception.

**Ordering key** is `registrations.requested_at` — the form submission time, or for imports the Google
Form response timestamp. Never `created_at`: an import run a week later must preserve original
submission order, and with two registration rounds this matters more, not less.

## 7.5 Extras review screen

Scoped to one segment.

- Header shows the live pool: `extras_pool` seats, N requests for M seats.
- Table sorted by `requested_at ASC`: position, requested time, round, player, contact, seats
  requested, guest names, running cumulative total, granted count.
- **Preselection is a strict FCFS greedy walk by cumulative seat count** — walk in time order,
  selecting until the next request would exceed the pool. The boundary request is granted in part when
  `allow_partial_grant` is on, otherwise skipped whole. Strict order, never best-fit: first come first
  served means the clock decides, not the packing.
- Admin toggles rows and edits granted counts freely; the header recomputes live. Ticking beyond the
  pool is **allowed** — the row is flagged, the header shows the overage, and commit above the
  segment's capacity or the hall's requires a typed confirmation written to `audit_log`. Preselection
  is the recommendation; the admin is the decision.
- Commit runs in one transaction, moves granted rows to `CONFIRMED`, leaves the rest `WAITLIST`, and
  **queues** the resulting emails without sending (`email.md` §11.2).

## 7.6 Manual and late registrations

Players registering after the form closes are expected, not exceptional. Admin can create a
registration against any segment bypassing form windows; edit contact details, player link and guest
list; add, rename or remove attendees; move a registration between segments or shows; cancel and
restore; and exceed the show's `capacity` with a typed confirmation recorded in `audit_log`.

Manual actions still route through `claim_seats()` so counters stay consistent. Only the hall ceiling
is overridable, and only deliberately.

**Delete and cancel are different facts, and the console offers both.** Cancelling says a real booking
is not coming: it frees the seats, stays in the record, and can be restored. Deleting says the row
should never have existed — a duplicate import, a test party, an entry against the wrong show — and it
leaves every screen. Only the second is reached by "delete".

The delete is **soft** (`deleted_at`, decision 7) and that is load-bearing rather than a retention
preference: `qr_token` and `ticket_code` are immutable for life (decision 28), and removing the row
would let Postgres issue the same ticket code again, so a printed ticket already in a pocket could
come to name a different guest. The seats free themselves — `claim_seats()`, `segment_pool()`,
`promote_seats()` and `manifest_for_show()` all filter `a.deleted_at is null and r.deleted_at is null`
already — and any `DRAFT` or `QUEUED` message for the registration is withdrawn in the same
transaction, exactly as cancelling does.

**A party holding a live check-in is refused**, with a sentence naming how many are already inside.
`check_ins` is append-only, so deleting the attendee would leave an admission referring to nobody and
drop a person the ushers actually saw out of the arrivals count. Reverting the check-in first, or
cancelling instead, are the two ways forward and the refusal says so. Nothing in the admin console
lists deleted registrations afterwards, so the `audit_log` entry carries what was removed.

## 7.7 Moving capacity between segments

Segments do not borrow automatically. When the player segment closes with unclaimed seats and public
demand remains, an admin edits both capacities (player 80, public 320). The edit is validated against
the hall total, refuses to drop a segment below its confirmed count, and is logged. Raising one segment
without lowering another is also valid so long as the total still fits the hall — that spends held
seats, which is exactly what they are for.

Automatic borrowing is deliberately excluded: it makes the number of people arriving at the door
unpredictable, which is the one number the front of house needs to trust.

## 7.8 Concurrency

Oversell must be impossible. All grants run inside one Postgres function that locks the **show** — not
the segment — so that concurrent claims across two segments cannot jointly exceed the hall:

```sql
create function claim_seats(p_segment_id bigint, p_registration_id bigint, p_requests jsonb)
returns jsonb language plpgsql as $$
begin
  perform 1 from shows s
    join show_segments g on g.show_id = s.id
   where g.id = p_segment_id
     for update of s;                      -- serialise per hall
  -- recompute confirmed / unclaimed_base / extras_pool for this segment
  -- verify the show-level hall ceiling across all segments
  -- insert attendees as CONFIRMED / PENDING_REVIEW / WAITLIST
  -- return {granted_base, granted_extra, pending, waitlisted}
end; $$;
```

Contention is irrelevant at this scale; correctness is not.

**Callers must run at `READ COMMITTED`.** The row lock serialises callers, but a
caller inside a `REPEATABLE READ` or `SERIALIZABLE` transaction recomputes the pool from the
snapshot it took *before* the lock was granted, so it reads stale counts and oversells. Nothing on
`shows` is ever updated, so Postgres has no write conflict to detect on our behalf and there is no
error. `claim_seats()` therefore refuses any other isolation level rather than trusting every future
caller to know. "Read the current state, then act" inside a repeatable-read transaction is a natural
Server Action shape, which is exactly why this is enforced rather than documented alone.

**The implemented signature extends the sketch above**, additively:

```sql
claim_seats(p_segment_id bigint, p_registration_id bigint, p_requests jsonb,
            p_override boolean default false) returns jsonb
```

- `p_requests` is the party: one object per seat, `{"full_name": …, "email": …,
  "allocation_type": "BASE"|"EXTRA"|"HELD"|"COMP"}`. Every field is validated; a missing or unknown
  `allocation_type` is an error rather than a default.
- `p_override` is the deliberate admin escape hatch of §7.6. It relaxes the **capacity ceilings** —
  the segment's and the hall's — and nothing else. It does not grant a player more base seats than
  their quota, because decision 17 is explicit that base entitlement has no opt-out. The caller owns
  the typed confirmation and the `audit_log` row.
- The return carries a fifth key, `granted_other`, counting granted `HELD` and `COMP` seats. Those
  are granted by this function but do not come out of the extras pool, so neither `granted_extra` nor
  silence would describe them honestly.

**A registration must be live.** Claiming against a `CANCELLED` or soft-deleted registration is
refused, and the registration row is locked for the duration — cancellation touches `registrations`
and takes no lock on `shows`, so without it a cancel committing mid-claim leaves `CONFIRMED` seats
under a dead registration: the pool excludes them and sells them again, while the door reads
`attendees.status` and sees valid ticket holders.

**Seats are written only by this function.** `attendees` refuses a direct insert, so "manual actions
still route through `claim_seats()`" (§7.6) is enforced rather than agreed. A fixture or fix-up
script may opt out per transaction, deliberately and visibly.

## 7.9 Cancellation

Cancelling sets `status = CANCELLED` and returns seats to that segment immediately. Admin sees "N seats
freed, M waiting". Auto-promotion is out of scope — promotion is deliberate, because it sends email.

**Where a cancelled BASE seat goes depends on the deadline**, and both cases fall out of §7.2 rather
than needing their own rule:

- **Before `base_claim_deadline`** — `base_claimed(p)` drops, so the seat returns to *that player's*
  entitlement. They can claim it again. This is right: the deadline has not passed, and their
  allocation is still theirs.
- **After the deadline** — `unclaimed_base` is zero by definition, so `extras_pool = open_seats` and
  the freed seat lands in the **extras pool**, available to the next person in the FCFS queue. The
  player does not get a private second chance after everyone else's window has closed.

No branch in code implements this; it is what the two formulas in §7.2 already say. State it here so
nobody later "fixes" it into a special case.

**A player claiming base *for the first time* after the deadline is still granted it, if seats
remain.** The deadline releases the *reservation* — §7.2 stops subtracting `unclaimed_base`, so those
seats become available to the extras queue — but §7.4's grant rule carries no deadline qualifier, and
nothing in the system tells a player their allocation has expired. So a late claimant competes for
whatever is left rather than holding seats back, and takes nothing that the queue has already taken.
The "private second chance" §7.9 rules out is the narrower case above: a seat *cancelled* after the
deadline goes to the queue rather than back to the player who released it.

*(This is the behaviour as implemented. It is the one place where §7.4 and §7.9 can be read against
each other, so it is written down rather than left to whoever reads them next.)*

Cancellation also **cancels any `QUEUED` or `DRAFT` outbox rows** for that registration, and never
clears `ticket_sent_at` — a ticket that was delivered was delivered, and the door needs to know the
code exists so it can show *"cancelled — refer to desk"* (`checkin.md` §12.1) rather than *"not found"*.
