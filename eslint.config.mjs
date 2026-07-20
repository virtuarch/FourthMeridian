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
    // Vendored third-party source (see components/atlas/vendor/*/VENDORED.md) —
    // kept pristine; not linted by our project rules.
    "components/atlas/vendor/**",
    // Design prototypes / harnesses — untracked local experiments, not production
    // source (V25-CLOSE-1 contained them; .gitignore and tsconfig agree).
    //
    // This is a TRUST fix, not a convenience one. CI lints only tracked files, so
    // thousands of prototype problems made `npm run lint` exit 1 locally while CI
    // saw something different — and that gap hid five real blocking errors in
    // tracked components for an entire release cycle (V25-CLOSE-1A). Local lint
    // must mean the same thing CI's lint means.
    "prototype/**",
    "app/prototype/**",
  ]),
  // Project-wide rule overrides
  {
    rules: {
      // Allow variables prefixed with _ to be declared but not used.
      // Useful for destructuring patterns like const [, err] or seed script
      // variables created for side-effects (e.g. _jnVehicle = await createFullAccount(...)).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern:    "^_",
          varsIgnorePattern:    "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;
