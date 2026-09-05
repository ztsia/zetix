/**
 * Stands in for the `server-only` package under Vitest.
 *
 * `server-only` works by resolving to a module that throws unless the bundler
 * picked its `react-server` condition. Vitest is not Next and does not, so every
 * server module that guards itself with it would fail at import — the guard is
 * doing its job, in a context where the job does not apply.
 *
 * Aliased in `vitest.config.ts`. This keeps the real guard in place for the
 * application build, which is the only place it means anything.
 */
export {};
