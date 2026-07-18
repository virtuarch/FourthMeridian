/**
 * components/atlas/fields/fields.test.ts  (UI Convergence Wave 1 — W1-D)
 *
 * Guards for the promoted Atlas form primitives. Standalone tsx (house pattern):
 * npx tsx components/atlas/fields/fields.test.ts — exits 0/1. Auto-discovered by
 * scripts/run-tests.ts. The tokens are runtime-checked; the React components are
 * source-scanned (no DOM runner in-repo, per space-shell.test.ts).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { INPUT_BASE, inputStyle } from "@/components/atlas/fields/tokens";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");
const has = (rel: string) => existsSync(path.join(process.cwd(), rel));

console.log("canonical surface tokens");
{
  check("INPUT_BASE is a non-empty class string", typeof INPUT_BASE === "string" && INPUT_BASE.includes("rounded"));
  check("inputStyle uses the inset surface token", inputStyle.background === "var(--surface-inset)");
  check("inputStyle uses the hairline border token", inputStyle.borderColor === "var(--border-hairline)");
}

console.log("field-kit barrel completeness");
{
  const barrel = read("components/atlas/fields/index.ts");
  for (const name of ["Label", "HelpText", "FieldError", "Input", "Select", "Toggle", "Field", "SelectOption", "SaveResult", "FieldSaveFn", "INPUT_BASE", "inputStyle"]) {
    check(`barrel exports ${name}`, barrel.includes(name));
  }
}

console.log("promoted primitives exist");
{
  for (const f of [
    "components/atlas/fields/Field.tsx",
    "components/atlas/fields/Input.tsx",
    "components/atlas/fields/Select.tsx",
    "components/atlas/fields/Toggle.tsx",
    "components/atlas/Toast.tsx",
    "components/atlas/InlineBanner.tsx",
    "components/atlas/EmptyState.tsx",
    "components/settings/SettingsSection.tsx",
  ]) {
    check(`${f} exists`, has(f));
  }
}

console.log("Toast contract");
{
  const toast = read("components/atlas/Toast.tsx");
  check("exposes ToastProvider + useToast", /export function ToastProvider/.test(toast) && /export function useToast/.test(toast));
  check("useToast no-ops without a provider (never crashes a tree)", toast.includes("?? NOOP"));
  check("viewport uses the --z-toast layer token", toast.includes("var(--z-toast)"));
  check("toasts self-dismiss (setTimeout)", toast.includes("setTimeout"));
}

console.log("no atlas → settings dependency (layering)");
{
  // Atlas primitives are domain-neutral; none may import from components/settings.
  for (const f of ["components/atlas/fields/index.ts", "components/atlas/Toast.tsx", "components/atlas/InlineBanner.tsx", "components/atlas/EmptyState.tsx"]) {
    check(`${f} does not import from components/settings`, !read(f).includes("@/components/settings"));
  }
}

if (failures > 0) {
  console.error(`\nfields.test: ${failures} failure(s).`);
  process.exit(1);
}
console.log("\nfields.test: all passed.");
