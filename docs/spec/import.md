*Spreadsheet import: the normalized sheet, mapping profiles, validation, dry run, commit.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `C`.
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 9. Spreadsheet import

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
| Registration already exists for this player + show | Blocking — skip row |
| Player not matched (`PLAYER_INVITED` only) | Blocking until resolved |
| `allocation_type` text matches no configured value | Blocking — the profile is wrong, and guessing spends the wrong seats (§9.5) |
| Attendee name blank but the seat is real | Info — attendee created with a placeholder name (`v2.md` §8.2.1) |
| Party exceeds `form.max_tickets_per_response` | Warning — import and flag; the cap governs the form, and an admin may have granted more |
| Import would exceed the segment's or the show's capacity | Blocking — report overflow, admin chooses to cap in row order or raise capacity |

Imports run through `claim_seats()` in `requested_at` order, so capacity rules cannot be bypassed by
importing. Under `REVIEW` policy, imported extras land as `PENDING_REVIEW` alongside form requests and
compete fairly on timestamp.

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
