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
