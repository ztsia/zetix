# End-to-end specs

Written by the `qa-reviewer` subagent during a module's QA pass and kept because they encode
things unit tests cannot: the authorization matrix filled in by actually making each call, the
`DataTable` behaving in a browser, and regression tests for bugs a QA pass found.

**These do not run in CI.** `.github/workflows/ci.yml` runs `pnpm test` (Vitest) only. Everything
CI must enforce belongs in `tests/`, not here — F2's authorization boundary is covered by
`tests/auth/guards.test.ts`, `tests/auth/show-access.test.ts` and `tests/auth/export-route.test.ts`
for exactly that reason.

## Running them

```bash
./scripts/qa-db.sh                                    # fresh zetix_qa
DATABASE_URL=postgresql://postgres@localhost:55432/zetix_qa pnpm db:seed
QA_DATABASE_URL=postgresql://postgres@localhost:55432/zetix_qa pnpm exec playwright test
```

`QA_DATABASE_URL` must be exported for the **test process**, not only the web server —
`playwright.config.ts` passes it to `pnpm dev` but the specs open their own connection.

**Specs that sign in need an auth provider holding seeded users.** There is no
`SUPABASE_SERVICE_ROLE_KEY` in a cloud container (`docs/local.md` §7), so a real `ADMIN` cannot be
created there; the F2 QA pass pointed `NEXT_PUBLIC_SUPABASE_URL` at a local stand-in GoTrue and
seeded users into it, with no change to `src/`. Specs that only exercise signed-out paths —
`f2-shell.spec.ts`, `f2-throttle-bypass.spec.ts` — run against the real project as-is.
