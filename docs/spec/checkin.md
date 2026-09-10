*The door: scanner, offline tolerance, feedback, and the check-in dashboard.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `G` (the scanner, §12.1–§12.3) and `H` (the dashboard, §12.4).
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 12. Door check-in

## 12.1 Scanner

A mobile web app at `/scan` for `OPERATOR` and `ADMIN`.

**Signing in.** Operators enter a **display name and an access code**, both issued by the admin. There
is no email in the operator's world: the synthetic address is an implementation detail they never see
or type.

Behind the form this is Supabase Auth against a synthetic address (`<slug>@operators.invalid`) with the
code as the password, so session handling, password hashing, refresh, revocation and rate limiting all
come from the platform. `.invalid` is reserved by RFC 2606 for names guaranteed never to resolve, which
is what this is: an identifier shaped like an email because Supabase's password provider is keyed on
one. Nothing is ever sent to it, and the operator never sees or types it.

Creating an operator is one call:

```ts
await supabaseAdmin.auth.admin.createUser({
  email: `${slug}@operators.invalid`,
  password: code,
  email_confirm: true,   // synthetic address; no confirmation mail can ever arrive
});
```

`email_confirm: true` is the whole of the "synthetic address" overhead. Omit it and the operator sits
unconfirmed and cannot sign in.

The session persists on the device, so an usher signs in once during setup rather than at the door.

- **The show picker lists only the operator's assigned shows.** With exactly one assignment — the
  common case — it is auto-selected and the pill (`ref.md` §1.3) renders read-only, removing the
  single most damaging setup mistake: an usher admitting against the wrong show.
- Camera scan via `@zxing/browser`. HTTPS required.
- Continuous scanning with `checkin.scan_debounce_ms` per token to stop double-fires.
- Manual fallback: type or search `ticket_code`, or search by attendee name. The code matches from
  three characters up, not only in full: `ORC` is a constant prefix, so what an usher reads off a
  printed ticket and types is the four-symbol body, and requiring the whole string meant `7KTD`
  found nothing while `ORC-7KTD` found the ticket.

**Parties arrive together, and only one phone comes out.** A family of four holds four PDFs in one
email, and in practice the person at the front shows the first one while the other three walk in behind
them. Scan one, and three people are admitted but unrecorded — the stats tab is then wrong for the rest
of the night, which is the number the door uses to decide when to stop holding seats.

So every scan result carries **party context**, and the manifest (§12.3) includes `registration_id` and
the party's size and check-in state to make it available offline:

```
✓  ALICE TAN                    admitted
   Party of 4 · 1 in, 3 remaining
   [ Admit remaining 3 ]
```

One tap writes three more `check_ins` rows with `source = MANUAL`. The operator is never forced to use
it — a party that genuinely splits up scans individually — but the alternative is asking an usher to
say "next, please" four times to the same family while a queue builds behind them.

A party of one shows no such control, so nothing changes for the common case.

**Result states**, readable at arm's length in a dim foyer:

| State | Colour | Shows |
|---|---|---|
| Admitted | Green | Name, allocation type, inviting player |
| Already checked in | Amber | Name, first scan time, operator |
| Wrong show | Red | The show the ticket is actually for |
| Cancelled | Red | Name, "refer to desk" |
| Not found | Red | "Invalid ticket" |

Amber and red are **never hard blocks**. The operator can **Admit anyway**, recorded with
`source = MANUAL` and an `override_reason`. Turning away a real guest at a free concert is worse than a
duplicate row.

## 12.2 Scan feedback: colour, sound, haptics

Three channels, because no single one is reliable in a foyer.

**Colour** — a full-screen flash, held ~800ms. The only universally available channel; it must carry
the meaning on its own.

**Sound** — synthesised with the Web Audio API (oscillator nodes, no audio files to load):

| State | Tone |
|---|---|
| Admitted | Two ascending notes, 880 Hz → 1320 Hz, 80ms each |
| Already checked in | One note, 440 Hz, 200ms |
| Error (invalid / wrong show / cancelled) | Two descending notes, 300 Hz → 200 Hz, 150ms each |

**Gotcha:** browser autoplay policy blocks audio until a user gesture. The scanner must open with an
explicit **"Start scanning"** button whose handler creates and resumes the `AudioContext`. Without
this, the first several scans are silent on iOS.

**Haptics** — `navigator.vibrate()`: `[60]` admitted, `[40, 60, 40]` amber, `[200]` error.

**Gotcha:** **iOS Safari does not support the Vibration API at all.** On iPhone there is no vibration,
so colour and sound must be sufficient alone. Do not design a signal that depends on haptics.

A mute toggle is persisted per device. Foyers are loud — sound is a supplement to colour, not a
replacement.

## 12.3 Offline tolerance

Venue wifi is unreliable and a full house arrives inside twenty minutes. Scanning must not depend on
the network.

- On show selection, download a **manifest**: `[{ qr_token_sha256, ticket_code, name, player_name,
  status, registration_id, party_size }]` for every attendee — a few hundred rows, well under 200KB —
  into IndexedDB. `registration_id` and `party_size` are what make the party-admission control in
  §12.1 work with no network.

  **The manifest is the attendee roster, so its endpoint is the security boundary that matters.**
  `GET /api/checkin/manifest?showId=` must verify an `operator_show_assignments` row for the caller
  before returning a single byte. An operator who can request any `showId` can download the full name
  list of every show, which defeats the point of scoping.

  **Two independent layers, and the second one is in the database** (decision 20):

  1. **The handler**, which is the contract: `canAccessShow()` from `src/lib/auth/show-access.ts`.
     Reject with **404, not 403** — probing ids must not tell "not yours" from "not there"
     (`../modules.md` §5.2.1).
  2. **`manifest_for_show()`**, a `security definer` Postgres function reached by `supabase-js`
     `.rpc('manifest_for_show', { p_show_id })`. It resolves the caller from the JWT subject, checks
     `operator_show_assignments` itself, and returns **zero rows** — never an error — for an
     unassigned operator, a deactivated one, an unknown subject, an absent claim, or a show that does
     not exist. This is what survives a mistake in the handler.

  It is a function rather than an RLS policy on `attendees`, and that is decision **20b**, which
  amends decision 20's original wording. The short version: a policy is only reachable if
  `authenticated` has been *granted* the table, and that grant publishes the roster at
  `/rest/v1/attendees` to anyone holding the publishable key. `execute` on one function opens no such
  door. The function is `drizzle/0003_manifest_rls.sql`; its contract is fixed by
  `tests/auth/manifest-rpc.test.ts`.

  **The route may not read the roster any other way.** An `eslint` `no-restricted-imports` rule and
  `tests/auth/manifest-call-site.test.ts` both refuse a manifest route that imports `@/db/client` or
  the `attendees` schema — because the mechanism's one weakness is that its coverage is opt-in, and a
  route reading Drizzle instead would pass every test written about the function while having no
  second layer at all.
- Scans validate locally and enqueue.
- Online, each scan also POSTs immediately. Offline, the queue drains on reconnect, preserving the
  original `scanned_at` with `source = OFFLINE_SYNC`. The check-in endpoint re-verifies assignment on
  every write, including on delayed offline sync — an assignment revoked mid-event takes effect on the
  next sync rather than being trusted from the client.

  **The write path stays handler-only** — `canAccessShow()`, not `.rpc()` (decision 20b). A scan write
  is one row in an append-only, revertible log (decision 7), keyed by a token the operator is
  physically holding; its failure mode is a bad row someone reverts, not the disclosure of four
  hundred names. Routing a batch drain through PostgREST would buy a second layer on the cheaper of
  the two risks.
- Duplicates across two offline devices resolve only on sync. The server accepts both and flags the
  attendee as multi-scanned. Do not attempt distributed locking.
- Manifest expires at show start + `checkin.manifest_ttl_hours`.

## 12.4 Admin check-in dashboard

Live: confirmed, checked in, remaining, arrival rate over time, per-operator counts, and a searchable
scan log with revert (sets `reverted_at`, never deletes).
