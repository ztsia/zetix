*Identifiers, the QR contract, the template format, editor and PDF render.*

Part of the system specification — see [`README.md`](README.md) for the index, and
[`decisions.md`](decisions.md) before re-litigating anything here.

**Built by:** `D` (identifiers and render, §10.1, §10.4–§10.6) and `E` (the editor, §10.2–§10.3).
See [`../modules.md`](../modules.md) for what each label owns and when it runs.

---

# 10. Tickets

## 10.1 Identifiers

- **`ticket_code`** — human-readable, e.g. `ORC-7K4Q`. Crockford base32 (no `I`, `L`, `O`, `U`),
  collision-checked. Printed on the ticket, used for door lookup and phone support.
- **`qr_token`** — 128 bits of CSPRNG entropy, base62 (~22 chars), unique-indexed, unguessable. The
  only thing inside the QR.

**The QR encodes a URL**, not a bare token: `https://{APP_URL}/t/{qr_token}`. This is what makes it
multi-purpose (`v2.md` §13) — an audience phone camera lands in the portal; the operator scanner extracts the
token and validates it locally.

### The QR is data, not a link that has to resolve

Admission on concert night is the one thing in this system that must not fail, and the QR is its
narrowest point. A ticket is printed or screenshotted weeks earlier and can never be recalled, so
anything baked into it is permanent. The design therefore assumes the URL inside it **will** one day be
wrong — wrong domain, moved host, changed path — and makes that survivable.

**1. The scanner never dereferences the URL.** It decodes the string, extracts the token by pattern,
and matches it against the offline manifest. No DNS, no HTTP, no origin comparison — the decoded text
is opaque data that happens to look like a URL. A dead, changed, or simply wrong `APP_URL` therefore
cannot affect check-in at all. This is the load-bearing rule; everything else below is a convenience.

**2. Token extraction is origin-agnostic and path-agnostic.** The scanner accepts, in order: a bare
token; the last path segment of any URL; or any `[0-9A-Za-z]{22}` run at the end of the decoded string.
So `https://old-domain.vercel.app/t/TOKEN`, `https://tickets.example.org/t/TOKEN`, and `TOKEN` all
resolve to the same attendee. Never validate the host, and never require the path to be `/t/`.

**3. `qr_token` is immutable for the life of the attendee.** Reissuing a ticket (§10.5) re-renders the
PDF and may repin the template version, but **never** mints a new token. A guest who kept the printed
first copy must still get through the door.

**4. Three independent ways in.** QR scan (primary), `ticket_code` typed into the Search tab
(secondary, `surfaces.md` §15.4), attendee name search against the same offline manifest (tertiary). Two of the three
work with no camera and no network.

**5. Freeze the origin before the first render, not the first send.** This concert uses the Vercel
production hostname, `<project>.vercel.app` — see below.

**6. One blocking gate before the first blast.** Render a real ticket, print it, and scan it with an
actual usher phone — off paper and off a screen, in low light. Until that passes, no blast goes out. It
is in the runbook (`README.md` §18) as a blocking step, not a nice-to-have.

### Using the Vercel hostname instead of a custom domain

A custom domain is the more durable choice, because it can be repointed at another host without
touching an issued ticket. This project deliberately does not buy one, so the QR origin is Vercel's
production hostname. That is a sound decision here, for one reason and with three rules.

**The reason it is safe: admission does not depend on it.** Rule 1 above is what makes the domain
question a matter of convenience rather than risk. The scanner never resolves the URL, so even a
completely dead origin admits every guest. In V1 the only thing behind `/t/{token}` is a read-only
status page (`README.md` §4.1), so the worst realistic outcome is a ticket holder who taps their own QR early and
gets nothing — not a person turned away at the door.

**Rule A — use the production alias, never a deployment URL.** `<project>.vercel.app` is stable and
points at whatever is currently in production. The per-deployment hostnames
(`<project>-<hash>-<scope>.vercel.app`) change on **every** deploy and are dead within days. A ticket
rendered against one of those is born broken. `APP_URL` must be the bare production alias, set in the
Production environment only, and it must never be derived at runtime from `VERCEL_URL` — that variable
holds the deployment URL.

**Rule B — choose the project name once and freeze it.** The hostname is the project name, so renaming
the project, transferring it to a team account, or deleting and recreating it changes the origin of
every ticket already issued. Pick a short, permanent name before the first render and record it in the
runbook as a do-not-change. Nothing else about the deployment is affected by this constraint.

**Rule C — verify the rendered origin, do not assume it.** The pre-blast gate (rule 6) checks the QR
that actually came out of the renderer, which catches a preview-environment `APP_URL` before tickets
reach anyone.

Length is not a concern: `https://<project>.vercel.app/t/<22-char token>` is roughly 55 characters,
which at error correction M is a version-4 QR — 33×33 modules, about 0.75mm per module at the 25mm
minimum print size (§10.4). That reads comfortably off paper and off a cracked phone screen. A shorter
custom domain would save one QR version, which is not a difference anyone would notice.

If the origin does change after tickets are issued: point the old host at the new one with a 301 and
the portal links keep working; if the old host is gone entirely, the door is unaffected (rule 1) and
only the portal link dies.

## 10.2 Template layout format

A background asset plus absolutely-positioned elements, stored in `ticket_templates.layout`:

```jsonc
{
  "canvas": { "width_pt": 595, "height_pt": 280, "dpi": 300 },
  "elements": [
    { "id": "el_name", "type": "TEXT", "binding": "attendee.full_name",
      "x": 48, "y": 120, "w": 320, "h": 34, "rotation": 0,
      "font_family": "Inter", "font_size": 22, "font_weight": 600,
      "color": "#1a1a1a", "align": "left", "valign": "middle",
      "max_lines": 1, "overflow": "SHRINK" },
    { "id": "el_qr", "type": "QR", "binding": "attendee.qr_url",
      "x": 430, "y": 60, "w": 130, "h": 130, "ec_level": "M", "margin_modules": 2 },
    { "id": "el_code", "type": "TEXT", "binding": "attendee.ticket_code",
      "x": 430, "y": 196, "w": 130, "h": 18,
      "font_family": "JetBrains Mono", "font_size": 12, "align": "center" },
    { "id": "el_static", "type": "TEXT", "binding": null,
      "text": "Free seating · Doors {{show.doors_open_at}}",
      "x": 48, "y": 200, "w": 320, "h": 18, "font_size": 11, "color": "#666666" }
  ]
}
```

Element types: `TEXT`, `QR`, `IMAGE`, `RECT`. Bindings are picked from a list, never free-typed:

```
attendee.full_name   attendee.ticket_code   attendee.qr_url
registration.contact_name   player.full_name   player.instrument
show.name   show.starts_at   show.doors_open_at   show.venue_name   show.venue_address
concert.name
```

Dates render through a per-element `format` string (e.g. `EEE d MMM yyyy, HH:mm`).

## 10.3 Template editor

Admin-only canvas editor:

- Upload background: PNG/JPG, or PDF page 1. Canvas dimensions derive from the asset; for PDF the page
  box in points is authoritative.
- Drag, resize, rotate; snap-to-grid and alignment guides; arrow-key nudge (1pt, 10pt with shift);
  z-order, lock, duplicate, multi-select.
- Properties panel: binding picker, typography, colour, alignment, overflow behaviour.
- Live preview against a real attendee, plus a **"longest name in this show"** preview so overflow is
  caught before a whole show's tickets go out.
- Undo/redo. Templates are **versioned** — never mutate a template that has already issued tickets;
  clone it. *(V1 ships the versioning; undo/redo, snap, guides, lock, duplicate and multi-select are
  deliberately out — decision 34.)*
- **Three seeded default layouts** (Classic Landscape, Minimal Portrait, Wide Banner) that work with no
  background asset, so the system is usable before anyone opens the editor.

Library: **react-konva**, dynamically imported with `ssr: false`.

### The canvas approximates; the PDF preview does not

The editor measures text with whatever fonts the browser has, and the renderer measures it with the
embedded ones (§10.4). Those disagree, so the canvas is a design tool and not an answer to "does this
name fit". The editor therefore also renders the **unsaved** layout through the real renderer and
reports back which elements it clipped and which it could not draw at all. That is what makes the
longest-name preview a check rather than an impression — and it is the check that has to pass before
a blast, because the alternative is discovering the overflow at four hundred tickets.

### Uploaded artwork

Backgrounds and `IMAGE` elements are stored through one interface with two backends, and
`background_asset_path` holds the same opaque path whichever wrote it: **Supabase Storage** (a private
bucket) in production, and a **local directory** in development, tests and CI, selected by setting
`TICKET_ASSET_DIR`. The second is not a convenience — a cloud session has no service-role key and no
route to a bucket's contents (`../local.md` §7), so without it none of the upload, fetch or
background-render path could be tested at all.

`background_kind` is always derived from the stored path, never passed in beside it: two columns
describing one fact drift, and `PDF` beside a `.png` sends the renderer down the wrong branch and
prints a blank ticket.

Uploads are typed by their **leading bytes**, not by the browser's `File.type` or the filename. A
mistyped upload accepted here fails inside the render of every ticket in the show, with nothing
pointing back at the upload that caused it.

**Artwork is capped at 4 MB, and the cap is enforced in the browser first.** The number is chosen to
stay under the ~4.5 MB request body the platform accepts: past that the upload is rejected before
any of this code runs, as `text/plain` the editor cannot parse, so the admin sees only "the upload
failed" with no size and no limit in it and no way to know how much to shrink by. Refusing locally is
the only place the real numbers are still available to say, and the editor states the limit on the
field as well. The route keeps its own check for callers that are not the editor.

## 10.4 Rendering

Server-side, deterministic, consuming the same layout JSON as the editor:

| Background | Renderer | Output |
|---|---|---|
| PDF | `pdf-lib` — load the original, draw text and QR onto page 1 | PDF, vector design preserved |
| Image / none | `sharp` composite or `satori` + `resvg-js`, embedded via `pdf-lib` | PDF |

Always attach a **PDF**: it prints predictably and every phone opens it. QR at ≥25mm printed, error
correction M.

Render on demand rather than storing, to stay inside free storage limits; cache to Storage keyed by
`attendee_id + template_version` only when a ticket is fetched repeatedly.

**Fonts must be self-hosted and embedded** — serverless runtimes have almost no system fonts, and the
render must match the editor.

**A character with no glyph is drawn, not dropped.** Inter and JetBrains Mono carry no CJK, so a
Chinese name printed as a row of `|x|` boxes: a PDF reader draws `.notdef` rather than failing, and
nothing in the render path noticed. A fallback face (Noto Sans SC) is vendored for exactly this, and
it is **never embedded** — the renderer takes the outline of each missing character and draws it as a
vector path.

The reason it draws rather than embeds is size. `subset: false` is not negotiable in this renderer
(pdf-lib's subsetter blanks glyph outlines, §10.4's `glyphs.test.ts`), so an embedded CJK face is
10MB *per ticket* and a party of four no longer fits in an email. A 2MB subset trades that for a
coverage cliff exactly where rare characters live, which is personal names. Drawing costs about 4KB
for a three-character name and covers every character the face has.

The cost, which is real: text drawn this way is artwork. It prints, scans and photographs
identically, but cannot be selected or searched inside a PDF reader. Admission matches on `qr_token`,
never on anything printed (§10.1), so nothing operational depends on it.

**Names are cased for print.** A form is typed by whoever filled it in, so the same run carries
`LOH KAI XIN`, `loh kai xin` and `Loh Kai Xin`. The renderer title-cases person-name bindings on
the way to the page; the stored row keeps what the guest typed, so the sheet and the admin screens
still agree, and a later correction to the rules reaches every ticket not yet rendered. A name
already carrying mixed case is left alone — `McDonald` was a decision, and a decision beats a rule.

**QR contrast is a rendering constraint, not a design preference.** Artwork with a busy or dark region
behind the QR will not scan. The renderer always draws an opaque light backing plate under the QR with
a quiet zone of at least `margin_modules`, regardless of what the template background looks like. The
editor shows this plate so the layout is honest about the space it takes.

## 10.5 Template versions are pinned at issue time

Rendering on demand creates a trap: if an admin edits a template after tickets have been emailed, every
already-issued ticket would re-render differently on its next download. The PDF in someone's inbox and
the PDF behind their portal link would disagree, and the door would be scanning against a design nobody
sent.

So: **`attendees.ticket_template_id` and `ticket_template_version` are written when the ticket is first
issued, and rendering always uses the pinned version.** Editing a template creates a new version and
affects only tickets issued afterwards.

**A version nothing has been issued against is edited in place.** The rule above is "never mutate a
template that has already issued tickets", and that condition is the whole of it: a version no
attendee points at has no copy anywhere to disagree with, so rewriting it is invisible. Versioning
every save instead would mint a version per nudged text box, and "version 34" would tell an admin
nothing about what changed. The count and the write are one transaction, with the template row locked
— otherwise a blast issuing tickets between the two would pin attendees to a version whose layout
changed underneath them, which is this section's failure arriving through a race instead of a design
mistake.

**A template can be deleted, and the same rule decides when.** The delete is soft (`deleted_at`) and is
refused in exactly two cases, both of which protect a ticket somebody is already holding:

- **Any version tickets are pinned to.** Reissuing re-renders from the pinned row, so deleting it
  would leave a delivered ticket unable to re-render — the one thing the pinning exists to prevent.
  The refusal names how many tickets are pinned, because that number is the decision; duplicating the
  template is the way to start from its design instead.
- **The default.** It is what `resolveTemplateForShow()` falls back to, so removing it would make the
  next issue fail with a question about templates rather than about the ticket being issued. Naming a
  new default first is one click and leaves the concert always able to issue.

Unversioned drafts and abandoned duplicates — the templates the delete exists for — are pinned by
nothing and are not the default, so they simply go.

A new version keeps its predecessor's `is_default` and records what it was edited from in
`supersedes_id`. **Duplicating** a template is different in kind: it starts a fresh lineage at
version 1 with no `supersedes_id`, because it is not an edit of the original and nothing about it
should read as history they share.

Re-rendering an already-issued ticket against a newer template is possible but explicit — an admin
action, "Reissue tickets with current template", which repins the version, clears `ticket_sent_at` for
the affected attendees, and queues a resend so the recipient actually receives what changed. It refuses
to run silently. It never changes `qr_token` (§10.1).

## 10.6 A bound field that changes after sending flags a reissue

The same trap applies to data, not just templates. If an attendee's name is corrected after their PDF
is already in someone's inbox, the ticket they hold and the ticket the system would render no longer
agree.

So any edit to a field bound into the template (§10.2) on an attendee with `ticket_sent_at` set marks
`needs_reissue = true` rather than silently diverging. Admin sees a "N tickets need reissuing" count
and resolves it deliberately — reissue and resend, or dismiss as cosmetic. The door is unaffected
either way, because check-in matches on `qr_token`, which never changes.
