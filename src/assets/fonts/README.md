# Ticket fonts

Vendored, not fetched. `spec/tickets.md` §10.4: **fonts must be self-hosted and embedded** —
serverless runtimes have almost no system fonts, and the PDF render must match what the editor
showed. A render that silently falls back to a substitute face changes every text metric, so
shrink-to-fit stops agreeing with the canvas and a name that fitted in the preview overflows on
the printed ticket.

Committed rather than downloaded at build time on purpose: a build that reaches out to
`fonts.gstatic.com` fails when that host is unreachable, and the day that matters is the day the
tickets go out.

| File | Family | Weight | Used for |
|---|---|---|---|
| `Inter-Regular.ttf` | Inter | 400 | body text on the seeded templates |
| `Inter-SemiBold.ttf` | Inter | 600 | attendee name — `spec/tickets.md` §10.2's example uses `font_weight: 600` |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono | 400 | `ticket_code` — a monospace face so `8`/`B` and `5`/`S` stay distinguishable when read aloud at the door |

Both families are under the **SIL Open Font License 1.1**, which permits redistribution inside a
repository.

## Provenance

Fetched 7 Sep 2026 from the Google Fonts CSS API, which serves TTF to a desktop user agent:

```
https://fonts.googleapis.com/css2?family=Inter:wght@400
https://fonts.googleapis.com/css2?family=Inter:wght@600
https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400
```

then the `fonts.gstatic.com` URL out of each response. Inter is `v20`, JetBrains Mono is `v24`.

**If you re-fetch, check the three faces are still distinct.** Google sometimes serves one variable
font for several weights, and two identical faces is a failure that looks like success — the ticket
renders, the name is simply not bold. `tests/tickets/fonts.test.ts` measures the same string in each
face and fails if any two agree.

## Adding a face

The renderer maps `font_family` + `font_weight` from the layout JSON to a file. An unknown pair is
an error, never a silent fallback, for the reason at the top of this file. Adding a face means a
file here, an entry in the renderer's map, and a row in the table above.
