import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettierConfig from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettierConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "lib/database.types.ts",
    // Deno runtime (URL imports, `Deno` global) — a separate toolchain from
    // this Next.js app's Node/TypeScript config, not linted here.
    "supabase/functions/**",
  ]),
]);

export default eslintConfig;
