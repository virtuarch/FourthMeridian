/**
 * lib/platform/incidents/intelligence/r4-audience-type.test.ts  (PB-1 R4 — AudienceAuth stays the guard's shape)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/r4-audience-type.test.ts
 *
 * audience.ts declares AudienceAuth structurally (it must not import lib/platform/authorize,
 * which reaches the session layer). This file fails TYPECHECK if a guard result stops being
 * assignable to it, and fails at runtime if audience.ts starts importing authorize again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformAuth } from "@/lib/platform/authorize";
import type { AudienceAuth } from "./audience";

// Compile-time pin: every guard result is an AudienceAuth.
const assignable = (a: PlatformAuth): AudienceAuth => a;
void assignable;

const src = readFileSync(path.join(process.cwd(), "lib/platform/incidents/intelligence/audience.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
if (/from\s+["']@\/lib\/platform\/authorize["']|from\s+["']@\/lib\/session["']/.test(src)) {
  console.error("  ✗ audience.ts must not import lib/platform/authorize or lib/session (background-authority reachability)");
  process.exit(1);
}
console.log("  ✓ audience.ts imports neither authorize nor session; PlatformAuth is assignable to AudienceAuth (typecheck)");
console.log("\nr4-audience-type.test: all passed.");
