*Spreadsheet import: mapping profiles, validation, dry run, commit.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

---

# 9. Spreadsheet import

Needed for historical data and for any concert still collected on Google Forms.

## 9.1 Flow

Upload `.xlsx`/`.csv` → **choose the target segment** → select sheet and header row → map columns
(auto-suggested, §9.2) → validate (dry run, no writes) → review per-row report → commit (one
transaction, produces an `import_batch`).

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

SheetJS parses in the browser for preview and again server-side for the commit, so the client cannot
forge rows.

## 9.2 Repeating-group mapping

The hard part: a Google Form with "fill in your 4 allocated names, then optionally add extras" produces
a **wide** sheet.

```
Timestamp | Email | Your name | Guest 1 Name | Guest 1 Email | Guest 2 Name | … | Extra 1 Name | Extra 2 Name
```

One row becomes one `registration` plus N `attendees`. A plain column-to-field mapper cannot express
that, so the model has an explicit **guest group** concept that unpivots wide→long.

Auto-detection proposes groups from header patterns —
`/^(?<label>.*?)\s*(?<n>\d+)\s*(?<field>name|email|full name)$/i`, grouped by `label`, ordered by `n`.
The admin confirms or edits every proposal; auto-detection suggests, never applies silently.

## 9.3 Mapping profile config

```jsonc
{
  "header_row": 1,
  "identity": {
    "player_match": { "column": "Email Address", "strategy": "EMAIL" },
    "contact_name": "Your name",
    "contact_email": "Email Address",
    "requested_at": "Timestamp"
  },
  "guest_groups": [
    { "label": "Allocated", "allocation_type": "BASE", "rows": [
        { "full_name": "Guest 1 Name", "email": "Guest 1 Email" },
        { "full_name": "Guest 2 Name", "email": "Guest 2 Email" },
        { "full_name": "Guest 3 Name", "email": "Guest 3 Email" },
        { "full_name": "Guest 4 Name", "email": "Guest 4 Email" } ] },
    { "label": "Extra", "allocation_type": "EXTRA", "rows": [
        { "full_name": "Extra Ticket 1 Name" },
        { "full_name": "Extra Ticket 2 Name" } ] }
  ],
  "include_registrant_as_attendee": false,   // false for player imports, true for public — see below
  "extra_fields": { "accessibility": "Accessibility needs" },
  "transforms": {
    "trim_whitespace": true, "lowercase_emails": true,
    "titlecase_names": false, "skip_blank_guest_rows": true
  }
}
```

**`include_registrant_as_attendee` differs by audience, and getting it wrong is silent.** On a
`PLAYER_INVITED` import it is `false`: the player is performing and consumes no seat (`decisions.md` §19.1 #3). On a
`PUBLIC` import it is normally `true`: the person who filled the form is usually attending, and if the
sheet lists only their guests, leaving this false quietly under-issues by one ticket per party — a
mistake nobody notices until someone is at the door without a ticket. The import preview shows the
resulting seat count per row precisely so this is visible during the dry run.

`player_match.strategy`: `EMAIL` (exact, case-insensitive), `NAME` (normalised exact), or `NAME_FUZZY`
(trigram similarity; anything below `import.fuzzy_match_threshold` requires explicit confirmation).
Unmatched players are listed and can be created inline or skipped.

Profiles are saved and reusable, since each concert's form differs slightly.

## 9.4 Validation

| Check | Level |
|---|---|
| Malformed email | Warning — import and flag |
| Duplicate email within the file | Warning |
| Registration already exists for this player + show | Blocking — skip row |
| Player not matched | Blocking until resolved |
| All guest cells blank | Skip row silently — unless a seat count is mapped, in which case create that many placeholder attendees (`v2.md` §8.2.1) |
| Guest name blank but seat is real | Info — attendee created with a placeholder name (`v2.md` §8.2.1) |
| Guest count exceeds base quota | Info — surplus becomes `EXTRA` |
| Party exceeds `form.max_tickets_per_response` | Warning — import and flag; the cap governs the form, and an admin may have granted more |
| Import would exceed the segment's or the show's capacity | Blocking — report overflow, admin chooses to cap in row order or raise capacity |

Imports run through `claim_seats()` in `requested_at` order, so capacity rules cannot be bypassed by
importing. Under `REVIEW` policy, imported extras land as `PENDING_REVIEW` alongside form requests and
compete fairly on timestamp.
