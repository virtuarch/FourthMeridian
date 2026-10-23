import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// The public site's lint mirrors its structural tests (tests/*.test.mts) so a
// violation is flagged in the editor, not only in CI. The tests are the proof;
// these rules are the early warning.
const APP_ONLY_PACKAGES = [
  "@prisma/*", "prisma", "next-auth", "next-auth/*", "@auth/*", "plaid", "react-plaid-link",
  "openai", "@sentry/*", "pg", "@supabase/*", "bcryptjs", "bcrypt", "jose", "otplib", "resend",
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
  {
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["@/*"], message: "`@/` is the financial application's alias. Site code imports @site/* or relative paths inside site/." },
          { group: ["../../*", "../../../*"], message: "Stay inside site/ — use the @site/* alias for non-sibling imports." },
          { group: APP_ONLY_PACKAGES, message: "The public site holds no application authority (site/README.md)." },
        ],
      }],
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[object.name='process'][property.name='env']",
        message: "Only lib/public-config.ts reads the environment.",
      }],
    },
  },
  {
    files: ["lib/public-config.ts", "scripts/**", "tests/**"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["tests/**", "scripts/**"],
    rules: { "no-restricted-imports": "off" },
  },
]);
