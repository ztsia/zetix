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
     * scanning is a real cost (spec.md §12.1).
     */
    files: ["src/components/ui/**/*.tsx", "src/hooks/use-mobile.ts"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
