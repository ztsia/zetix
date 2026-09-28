*Spreadsheet import: the normalized sheet, mapping profiles, validation, dry run, commit.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `C`.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 9. Spreadsheet import

> **Superseded in part by V3** (`v3.md` §25.7, decision 49). Rows now land in an editable **staging
> grid** and commit a party at a time; the timestamp is optional; parties group by contact email within
> the segment; wide sheets map their guest columns as seat groups; a batch can be undone. §9.2's
> grouping key, §9.4's run-wide blocking rule and §9.6's dry run and one-shot commit describe V1 and
> were retired with it. Mapping profiles (§9.3), the allocation-type rules (§9.5) and player matching
> are unchanged.

Needed for historical data and for any concert still collected on Google Forms.

## 9.1 Flow

**The sheet is normalized before it is uploaded: one attendee per row.** The admin flattens the wide
Google Form export in the spreadsheet, and the system does column mapping only (§9.2, decision 33).

Upload `.xlsx`/`.csv` → **choose the target segment** → select sheet and header row → map columns
(§9.3) → validate (dry run, no writes) → review per-row report → commit (one transaction, produces an
`import_batch`).

**One import run targets exactly one segment.** A hybrid show is loaded by running the import twice,
once per file — the player-invited export into the player segment, the public export into the public
segment. This is why `import_batches` carries `segment_id`, not just `show_id`. A single file cannot be
split across segments: there is no reliable way to tell from a spreadsheet row which audience it
belongs to, and guessing would put someone in the wrong block.

**After commit, this database is the source of truth.** The spreadsheet is a one-way input, re-read
only to pick up *new* responses in a later round. There is no rollback and no re-sync: the dry run is
where mistakes are caught, and after commit rows are corrected through normal admin CRUD (`allocation.md` §7.6), which
is the same path used for late and manual registrations. A rollback feature would have to reason about
rows an admin has since edited and tickets already issued, and would earn its complexity only if the
dry run did not exist.

**The file is parsed once, server-side**, in a Route Handler declaring `export const runtime = 'nodejs'`
(`platform.md` §16.1). The browser uploads bytes and renders what the server reports; it never parses
and never submits rows. The client therefore cannot forge a row, and there is no second parser whose
behaviour could drift from the first.

## 9.2 One attendee per row

A Google Form that says "fill in your 4 allocated names, then optionally add extras" produces a **wide**
sheet — `Guest 1 Name | Guest 1 Email | Guest 2 Name | … | Extra 1 Name`. One such row is one
registration and N attendees.

**The system does not unpivot that.** The admin reshapes the export into one row per attendee before
uploading, in the spreadsheet, where a formula does it in a minute and the result can be eyeballed.
Building a guest-group editor with header auto-detection into the importer was considered and rejected:
it was the largest part of this module and all of its silent-failure surface, for a reshaping step that
is trivial in the tool the file already lives in (decision 33).

The importer therefore takes a **long** sheet:

```
Timestamp | Contact Name | Contact Email | Attendee Name | Attendee Email | Ticket Type
```

### Rows are grouped into parties, and the grouping key is not optional

A registration is a party of N: one email, N `qr_token`s, N PDFs (decision 31), and every message is
addressed to the registration rather than the seat (decision 22). A long sheet has thrown that grouping
away, so the importer has to rebuild it. **Rows sharing the same `contact_email` and the same
`requested_at` form one registration.**

Both halves of that key are load-bearing. Email alone would merge a person's round-1 and round-2
registrations into one oversized party; the timestamp separates them, because a second submission is a
second response with its own time. A mapped `group_key` column overrides the rule outright when the
sheet already carries a party id.

**The dry run reports the grouping it derived** — *"38 rows → 12 registrations, largest party 4"* — with
the party breakdown per registration. This is the check that makes the whole simplification safe: a
grouping mistake is visible before commit rather than discovered as four separate emails in someone's
inbox. Rows in one group that disagree about `contact_name` or the matched player are a **warning**, and
the first row in file order wins.

Rows with no `contact_email` cannot be grouped by the rule and each become their own registration; the
dry run counts them separately so the number is never a surprise.

### The same grouping key is what makes a second import safe

Registration runs in rounds (`../context.md` §3), and a Google Form export is cumulative: the round 2
download is round 1 plus whatever arrived since. So the importer must assume it will be handed rows it
has already committed, and the natural admin workflow — append to the one sheet, re-upload it — has to
be the safe one. Requiring a fresh file of only-new rows each time puts the deduplication in the
admin's head, where a mistake is a party that gets two emails, four tickets and two seats out of a
pool that was sized for one.

**A party whose `contact_email` and `requested_at` already match a registration in this segment is
skipped, not re-imported, and not blocked.** "Already imported" means the registration is still on
record, cancelled or not — see the two rules below for why a cancellation counts and a deletion does
not. It is the same pair §9.2 groups on, and both halves are
already immutable: `requested_at` is the form response timestamp rather than import time (§9.3), so it
is identical in every export of that response. Re-uploading the whole sheet each round therefore
commits exactly the rows that are new.

Skipping is `INFO` and never blocking, because an already-imported party is the opposite of the
silent under-issue §9.4's blocking rule exists to prevent: the seats are there, the registration
exists, and stopping the run would refuse the new rows alongside it. The dry run states the skip count
beside the grouping line so a second import of an unchanged file reads as *"12 registrations, 12
already imported, 0 new"* rather than as success over nothing.

Four rules follow from that, all stated rather than worked around:

- **A cancelled registration still counts as imported.** A cancellation is an admin decision about a
  response that is already here, and §9.1 re-reads the sheet only for *new* responses — so
  re-importing would overturn that decision silently. It would also be unsafe rather than merely
  wrong: a cancellation "stays in the record, and can be restored" (`allocation.md` §7.9), so the
  restore would leave one form response holding two live registrations and two sets of tickets. The
  dry run says so in as many words, because an admin looking at a cancelled party needs to know why
  the importer is refusing to bring it back.
- **A deleted registration does not.** A delete means the row should never have existed
  (`allocation.md` §7.6) — a duplicate, a test party, an entry against the wrong show — so an export
  still carrying that response is bringing in something this segment genuinely does not have.
- **A party with no `contact_email` has no dedup key** and is re-imported every time, because §9.2
  already gives it a row-scoped key that nothing outside the file can match. It is `WARNING` on both
  runs, and the dry run counts it.
- **A party whose size has changed since it was imported is still skipped, but as a `WARNING`** naming
  both sizes. Someone appended a guest to an existing response's row; the seat is not silently added,
  because after commit this database is the source of truth (§9.1) and the correction path for a real
  registration is admin CRUD (`allocation.md` §7.6), not a second import writing into a party the
  admin may have already edited.

## 9.3 Mapping profile config

```jsonc
{
  "sheet": "Form Responses 1",
  "header_row": 1,
  "columns": {
    "requested_at": "Timestamp",
    "contact_name": "Your name",
    "contact_email": "Email Address",
    "attendee_name": "Attendee Name",
    "attendee_email": "Attendee Email",
    "allocation_type": "Ticket Type",
    "group_key": null                     // overrides the §9.2 grouping rule when mapped
  },
  "player_match": { "column": "Email Address", "strategy": "EMAIL" },
  "allocation_type_values": {             // sheet text → allocation_type, case-insensitive
    "BASE":  ["allocated", "base", "invited"],
    "EXTRA": ["extra", "additional", "guest"]
  },
  "default_allocation_type": "EXTRA",     // used when `allocation_type` is unmapped — see §9.5
  "transforms": {
    "trim_whitespace": true, "lowercase_emails": true, "titlecase_names": false
  }
}
```

`requested_at` comes from the **form response timestamp**, never from import time. It is the FCFS
ordering key (`allocation.md` §7.4), and an import run a week later must preserve the order people actually asked
in. With two registration rounds this matters more, not less.

`player_match.strategy`: `EMAIL` (exact, case-insensitive), `NAME` (normalised exact), or `NAME_FUZZY`
(trigram similarity; anything below `import.fuzzy_match_threshold` requires explicit confirmation).
**`NAME_FUZZY` is the default, and email matching is not.** Both the column and the strategy are
chosen on the mapping step. Matching on email is the obvious choice and is usually wrong here: the
player roster is loaded from a name list that carries no addresses, and the person filling in the
form is not necessarily the player. Choosing `EMAIL` against a roster with no addresses says so on
the mapping step rather than at the dry run.

**Confirming and correcting happens on the dry run**, not in the spreadsheet. Every name that
matched nothing, or matched below the threshold, is listed there with its best suggestion: accept it
in one click, or pick the right player from the roster. Choices are keyed by the cell value, so one
decision covers every row that wrote the same name, and they are sent with the commit as well as the
dry run — a commit that dropped them would silently reinstate the blocks the admin just cleared. The
ids are re-validated against the concert on both, and an overridden player is still refused by §7.6
if they already hold a registration: choosing by hand is not a way round the one-per-player rule.

Correcting in the sheet instead is always available, but it means editing responses after they were
collected, and the sheet stops being the source of truth at import (§9.1).

Unmatched players are listed and can be created inline or skipped. It applies to `PLAYER_INVITED`
segments only.

Profiles are saved and reusable, since each concert's form differs slightly.

There is no `extra_fields` map. Neither `registrations` nor `attendees` carries a column for arbitrary
form answers, the schema is frozen (`../modules.md` §4), and a mapping that silently discards what it
collects is worse than one that does not offer to collect it.

## 9.4 Validation

| Check | Level |
|---|---|
| Malformed email | Warning — import and flag |
| Duplicate email within the file | Warning |
| Rows in one party disagree on contact name or player | Warning — first row in file order wins (§9.2) |
| Row has no `contact_email` | Warning — becomes its own registration, counted separately (§9.2) |
| No contact name | Blocking — it is the identity of the party and the placeholder every unnamed seat tickets under |
| Timestamp missing or unreadable | Blocking — it is the FCFS ordering key, and import time is not a substitute (§9.3) |
| Party already imported into this segment (same contact email + response timestamp) | Info — skipped, counted separately (§9.2) |
| An imported party's size has changed since it was imported | Warning — skipped, both sizes named (§9.2) |
| Registration already exists for this player + show | Blocking — **unless** this party is the one already imported, which skips instead |
| Player not matched (`PLAYER_INVITED` only) | Blocking |
| `allocation_type` text matches no configured value | Blocking — the profile is wrong, and guessing spends the wrong seats (§9.5) |
| Attendee name blank but the seat is real | Info — attendee created with a placeholder name (`v2.md` §8.2.1) |
| Party exceeds `form.max_tickets_per_response` | Warning — import and flag; the cap governs the form, and an admin may have granted more |
| Import would exceed the segment's or the show's capacity | Blocking — report overflow, admin chooses to cap in row order or raise capacity |

**A blocking finding stops the whole run — it is never committed around.** Not the file, and not the
one party carrying it. A *skipped* party is the one thing that is not committed around but still lets
the run proceed, and it is not an exception to this rule: nothing is silently under-issued, because the
party it skips is already in the database with its seats (§9.2). Committing the remainder is the silent under-issue this module exists to avoid:
an unmatched player is a party that quietly receives no tickets, there is no rollback to discover it
with (decision 26), and nothing downstream will ask where they went. The admin resolves it where it
came from — remove the rows, fix the mapping, create the player — and dry runs again. Warnings and
info never block; that is the whole difference between the levels.

Imports run through `claim_seats()` in `requested_at` order, so capacity rules cannot be bypassed by
importing. Under `REVIEW` policy, imported extras land as `PENDING_REVIEW` alongside form requests and
compete fairly on timestamp.

### Capacity is two pools, not one

`BASE` seats draw on the segment's open seats; `EXTRA` seats draw on the **extras pool**, which is the
open seats minus the base still owed to players who have not claimed it (`allocation.md` §7.2). They are
different numbers, and sizing extras against open seats predicts that a file fits when the engine will
waitlist most of it — a dry run reporting no problem, then a success banner over an entirely
waitlisted party.

So the dry run states, beside the counts, **what the engine is predicted to do**: how many seats
confirm, hold as `PENDING_REVIEW`, and waitlist. It is a prediction rather than a promise — the engine
decides against the pool as it stands at commit — but a file whose seats will not fit says so before
the commit rather than after it.

## 9.5 What the engine decides, and what import must decide first

`claim_seats()` (`allocation.md` §7.8) grants the seats, but it takes an `allocation_type` per seat and
does not infer one. Three of its properties are not obvious from the outside and each has a silent
failure mode, so import handles them before it calls.

**A missing `allocation_type` is refused, not defaulted.** The engine raises *"every seat request needs
an allocation_type of BASE, EXTRA, HELD or COMP"*, hinting that a missing one is not `EXTRA` by default.
So every imported row resolves to one, either from the mapped column or from
`default_allocation_type`.

**`BASE` only ever grants in a `PLAYER_INVITED` segment with a linked player.** The engine sets the base
allowance to zero otherwise, so a `BASE` seat in a public segment is not an error — it is silently
waitlisted. A public import that mapped its rows as `BASE` would waitlist the entire audience and return
success. **Public seats are `EXTRA`**, which under the segment's `AUTO_FCFS` policy is what grants them
from the pool at intake. Import refuses a `BASE` row in a `PUBLIC` segment rather than passing it on.

**Surplus base is not promoted to extra by the engine.** A `BASE` seat beyond the player's quota
waitlists. `import` is what turns the surplus into `EXTRA` — walk each party in row order, take
`base_quota` seats as `BASE`, and reclassify the remainder to `EXTRA` before calling. The dry run
reports the reclassification as **info**, per row: *"3 of 5 seats exceed the base quota and will be
requested as extras."*

Everything else stays the engine's: whether an extras request is granted, held as `PENDING_REVIEW` or
waitlisted; the whole-party rule; the placeholder name for an unnamed attendee, which `claim_seats()`
generates itself as `"Guest of {contact_name}"` with `name_source = 'PLACEHOLDER'` (decision 32). Import
passes a null name through and lets it do that — it does not build the string.

## 9.6 The import screen

Admin surface, web-first (`surfaces.md` §15.1). Six steps, strictly linear, each gated on the one
before. The step body is a `Card`; the rail above it is an `ItemGroup` of `Item`s marking done,
current and upcoming. shadcn ships no stepper, and this is the composition that replaces one — a
`Tabs` bar would imply the steps are freely navigable, which they are not.

### Step 1 — Prepare your sheet

**This step exists because the normalization is now the admin's job (§9.2), and a step the system
depends on but never explains is a step that gets done wrong.** It renders before any file is chosen,
and it is not skippable on a first run.

It carries three things:

1. **A before-and-after example**, as a static `Table` — the wide export on one side, the normalized
   long sheet on the other, with the same two registrations in both so the reshaping is legible rather
   than described.
2. **A "Download template" button**, producing an `.xlsx` or `.csv` with exactly the headers §9.3
   expects, through the existing export helper (`src/lib/export/`). This is the strongest part of the
   step: an admin who fills the template in gets a sheet whose columns map themselves, and the mapping
   step becomes a confirmation rather than a task.
3. **A standing `Alert`: every row of one party repeats the same contact email and the same
   timestamp.** That pair is the grouping key (§9.2), and it is the one thing a careful admin would
   otherwise "tidy up" by filling the contact columns on the first row of each party only.

An `Accordion` holds the cases that are not the common path — a form that asked for a seat count
instead of names, a party whose contact has no email, a second-round file — so the default reading is
short.

### Steps 2–4 — Upload, sheet and header row, mapping

Upload is an `Input type="file"`; parsing reports through `Progress`, and a parse failure is an
`Alert variant="destructive"` that names the sheet and row, never a toast, because it is not
transient.

Sheet and header row are `Select`s, with the detected header row preselected and the first rows shown
beneath so the choice is verifiable rather than trusted.

Each mapping row is a `Field` with the target on the left and a `Select` of the file's actual headers
on the right. Unmapped optional targets stay visibly unmapped; a required target left unmapped puts
its `Field` in `data-invalid` and blocks Continue.

### The allocation-type control

One `RadioGroup` in choice-card form — `FieldLabel` wrapping a `Field`, per the shadcn Field
composition — with two modes:

| Mode | Then |
|---|---|
| **Every row is the same type** | A second control picks `BASE` or `EXTRA` for the whole file |
| **Read it from a column** | A `Select` picks the column; the screen then lists each **distinct value actually present in that column** as an `Item`, each mapping to `BASE` or `EXTRA` |

Listing the distinct values from the parsed file, rather than asking the admin to type them, is what
makes `allocation_type_values` (§9.3) correct by construction: a value in the file that maps to nothing
is visible as an unmapped row, which §9.4 makes blocking. Choosing the column with nothing yet mapped
is **not** a configured state: an empty value list must not let the step pass.

The dependent controls sit **outside** the choice card's `FieldLabel`. A `<label>` wrapping an
interactive control swallows the click and activates the label's own input instead, so a `Select`
nested inside the card renders correctly, opens nothing, and leaves the admin looking at a control
that does not respond.

**Only `BASE` and `EXTRA` are offered.** `HELD` and `COMP` are in the enum and are admin concepts —
seats withheld or comped by a person, one at a time. An importer that offered them invites a whole file
to arrive as `COMP`, outside the pool arithmetic, with no one having decided that seat by seat.

**In a `PUBLIC` segment the control is locked to `EXTRA`** and says why: a `BASE` seat in a public
segment is not refused by the engine, it is silently waitlisted (§9.5), so a public file mapped as
`BASE` would waitlist the entire audience and report success. The lock is the UI half of the refusal
§9.5 requires; both exist because either alone is one edit away from being the only one.

### Step 5 — Dry run

The per-row report is the shared `DataTable` (`../modules.md` §4 — it is not forked, and it needs no
extension: the level filter goes in its `toolbar` slot and the report exports through its own export
menu). One row per sheet row: line number, party, attendee, resolved allocation type, matched player,
and outcome. Level is a `Badge` — `destructive` for blocking, `secondary` for warning, `outline` for
info.

Above it, three things the table cannot say:

- **The derived grouping** — *"38 rows → 12 registrations, largest party 4"* — with the party sizes
  broken down. This is the check that makes §9.2 safe, so it is stated before the table, not inside it.
- **The seat outcome** — how many seats are predicted to confirm, hold as `PENDING_REVIEW`, and
  waitlist, against the segment's live pool from `segmentPool()`. Extras are sized against
  `extras_pool`, never `open_seats` (§9.4).
- **Blocking counts**, as an `Alert variant="destructive"` that disables Commit while any remain —
  any blocking finding, not only a file-level one. The server refuses the same commit independently,
  because there is no rollback and a gate that lives only in a component is one stale tab from being
  no gate at all.

### Step 6 — Commit

Behind an `AlertDialog`, because the commit is irreversible: there is no rollback and no re-sync
(§9.1, decision 26). The dialog states the counts it is about to write and requires the typed name of
the target segment — the same shape of confirmation §7.5 uses for an over-capacity grant. `Sonner`
reports the result; the `import_batch` id is the durable record.
