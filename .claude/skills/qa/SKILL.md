---
name: qa
description: Run an independent QA pass on the current branch before opening a PR. Spawns a clean-context QA reviewer that writes acceptance criteria and user flows from the spec, audits whether the tests have teeth, exercises the backend and authorization, then walks the flows end-to-end in a real browser with screenshots on both happy and sad paths. Use when a module is finished, before a PR, or when asked to verify, QA, or independently review work.
---

# QA pass

Verification by someone who did not write the code. This skill does almost nothing itself — it
sets up the run and hands off to the `qa-reviewer` subagent, whose clean context is the entire point.

## When to run it

- A module branch is finished, **before** opening its PR. This is the main case.
- A non-negotiable was touched — allocation, blast idempotency, template pinning, the manifest
  authorization check — even mid-module.
- Someone asks to verify, QA, or independently check work.

Not for a docs-only or config-only change. Check `git diff --stat main...HEAD`: if nothing under
`src/`, `qa/` or a migration moved, say so and skip.

## Running it

```bash
./scripts/qa-db.sh          # isolated database, safe to trash
```

Then spawn `qa-reviewer` via the Agent tool with `subagent_type: "qa-reviewer"`.

**Keep the prompt thin.** Name the branch, the module label, and the spec files from that module's
row in `docs/modules.md` §3. That is all.

> **Do not tell it what you built, how it works, or why you think it is correct.** Its value is
> that it derives the criteria from the spec independently. Briefing it with your reasoning turns
> an independent check into a confirmation of your own assumptions, which is the failure mode this
> whole arrangement exists to avoid. Do not pre-empt it with known issues either — if it misses
> something you already know about, that is a finding about the spec's clarity.

Run it in the background and keep working; it takes a while and does not need supervision.

## Reading the result

The agent returns a verdict and a findings table. The subagent's report is not shown to the user,
so relay what matters — verdict, counts, and every Blocker and Major in full.

- **Blocker** — a `CLAUDE.md` non-negotiable is violated. Fix it and re-run the QA pass. Do not open
  the PR, and do not downgrade it because the schedule is tight; these are the failures that end the
  concert on 19 Sep.
- **Major** — fix, or record in the branch handoff why it is deliberate. Never silently.
- **Minor / Note** — judgement. Say what you are leaving and why.

Findings you disagree with are worth arguing back against — the agent works from the spec and can
misread it. But argue from the spec, not from what you meant. If the spec is genuinely ambiguous,
that is a spec bug: fix `docs/spec/`, since the next module will misread it the same way.

Screenshots and the full report land in `qa-artifacts/<branch>/`, which is gitignored — deliberately.
Eleven branches of PNGs would bloat the repo, and they are evidence for this run, not a record. If a
finding needs to outlive the container, put it in the branch's handoff.

## Notes on how it is set up

**Its own database, not yours.** `scripts/qa-db.sh` drops and recreates `zetix_qa` on the same local
Postgres. QA deliberately fills segments to capacity, cancels registrations and presses Send twice;
in the dev database that destroys the fixtures you are working against, and leaves residue that makes
the next run mean something different. A second database on the same server costs nothing. Neither
touches Supabase — there is no route from this container, and QA has no reason to want one.

**The browser is already here.** Chromium 141 ships in the cloud image and `@playwright/test` is
pinned to 1.56.1 to match it, with `playwright.config.ts` at the repo root. Nothing to install —
`playwright install` would fetch a second copy that may not match, so never run it. The config starts
`pnpm dev` on :3100 against `zetix_qa` and runs single-worker on purpose: parallel workers would let a
capacity assertion pass for the wrong reason.

**It checks whether the tests are real.** Phase 3 breaks the implementation on purpose and confirms
the suite notices. This is worth the minutes: `pnpm test` going green is a claim about the tests, not
about the code, and a test that stays green while `claim_seats()` is deliberately broken is worse than
no test — it is a regression alarm nobody will hear. It reverts every probe and finishes on a clean
tree.

**No UI yet is not a reason to skip.** `F1` has no screens; the run does phases 1–4 and says so.
Concurrency, the entitlement guard and the cascade are all testable from `psql` alone.
