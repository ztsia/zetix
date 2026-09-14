# Manuals

End-user documentation, written for people who do not read `docs/spec/`.

| File | Audience | Covers |
|---|---|---|
| `admin.html` | Committee members with the shared `ADMIN` code | The whole console: concert → shows → segments → players → import → extras → tickets → blast → operators → check-in, plus a glossary, a troubleshooting table and a run sheet |
| `operator.html` | Ushers on the door | `/scan` only: sign-in, the show pill, the three tabs, the five scan results, party admission, offline behaviour |

Both are single self-contained HTML files. Open them in a browser; nothing is
built or served.

## Rules these files follow

- **No operational values.** No capacity, quota, deadline, party cap or date from
  `docs/context.md` appears in either file, for the same reason `CLAUDE.md` keeps
  them out of `.ts`. They teach the system, not this concert. Examples are
  labelled as examples.
- **`docs/spec/` is still the contract.** These describe the console as built. If
  a manual and the spec disagree, the spec wins and the manual is the bug.
- **They are read once and kept.** Unlike `docs/handoff/`, these are durable and
  updated in place when a screen changes.

## Publishing

**Not published yet.** They are intended to go out as Artifacts once V1's
remaining work lands — the 19 Sep concert configured, the printed-ticket scan
test, and the 400-ticket dry run (`docs/local.md`). Until then they live here.

Before publishing, re-check anything the manuals describe as unfinished:

- `admin.html` §"Not built yet" lists Forms, Portal, Notes and Exports as
  placeholder screens. Remove a row when its screen ships.
- `admin.html` §"When something looks wrong" mentions the confirm-dialog bug
  (`AlertDialogAction` does not close its dialog — 25 call sites across 7 files).
  Delete that row when it is fixed.
