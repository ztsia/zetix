import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    /**
     * QA run output — screenshots, traces, the rendered report. Generated, not
     * authored, and gitignored. Without this, `pnpm lint` fails for anyone who
     * has run the QA suite locally, which trains people to ignore lint.
     */
    "qa-artifacts/**",
    /** The demo video's Remotion edit: its own project, gitignored (spec/v3.md §31). */
    "video-edit/**",
  ]),
  {
    /**
     * Vendored shadcn/ui source. We do not author these files — `shadcn add`
     * writes them and would overwrite any fix on the next run.
     *
     * Next 16 enables `react-hooks/set-state-in-effect`, which upstream shadcn
     * does not yet satisfy. In both offending files the effect reads a browser
     * API that is unavailable during SSR (`window.innerWidth`, an embla
     * instance) and syncs it into state on mount — the "subscribe to an
     * external system" case the rule's own docs allow, flagged because the
     * initial sync is synchronous.
     *
     * Scoped off here rather than disabled globally: the rule earns its keep in
     * the door scanner, where a cascading render during continuous camera
     * scanning is a real cost (spec/checkin.md §12.1).
     */
    files: ["src/components/ui/**/*.tsx", "src/hooks/use-mobile.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    /**
     * The check-in manifest is the full attendee roster, and decision 20 wants
     * two independent layers on it: the handler check, and `manifest_for_show()`
     * in the database (decision 20b, `drizzle/0003_manifest_rls.sql`).
     *
     * The second layer is opt-in by construction — it protects reads that call
     * it. A manifest route that reads `attendees` through Drizzle instead would
     * pass every test written about the function and have no second layer at
     * all, which is precisely the shape of bug two QA passes already found on
     * this branch: a test that covers the function but not the call site.
     *
     * So the route is denied the tools to do it. This is deliberately scoped to
     * the manifest and not to the whole scanner surface: `/scan` legitimately
     * reads `shows` over Drizzle to render a picker, and the scan-write path
     * legitimately writes `check_ins` (see decision 20b on why writes stay
     * handler-only). Widening this to `(scanner)/**` would only teach people to
     * add exceptions.
     */
    files: ["src/app/api/checkin/manifest/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/db/client",
              message:
                "The manifest must come from .rpc('manifest_for_show'), not from Drizzle — that call is the second layer decision 20 requires. See drizzle/0003_manifest_rls.sql.",
            },
            {
              name: "@/db/schema/registrations",
              message:
                "Reading attendees or registrations here bypasses manifest_for_show(), leaving the roster with only the handler check. See decision 20b.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
