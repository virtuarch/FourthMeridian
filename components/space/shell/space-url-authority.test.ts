/**
 * components/space/shell/space-url-authority.test.ts
 *
 * SD-0A / SD-0B ratchets (source-scan — no DOM runner exists in this repo).
 *   npx tsx components/space/shell/space-url-authority.test.ts
 *
 * Pins the two Phase-0 foundation invariants that types/runtime tests can't:
 *   1. ONE URL authority — window.history writes + the popstate listener live
 *      ONLY in useSpaceUrl.ts; SpaceDashboard and the shell time hook route
 *      through it and never touch window.history or register their own popstate.
 *   2. ONE time authority — there is no second mutable cashFlowPeriod state;
 *      Cash Flow's period is derived from the canonical shell slice.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) { failures++; if (detail) console.log(`        ${detail}`); }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, ...p.split("/")), "utf8");
/** Strip comments so prose that mentions an API doesn't trip a code ratchet. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const dashCode  = stripComments(read("components/dashboard/SpaceDashboard.tsx"));
const shellCode = stripComments(read("components/space/shell/usePerspectiveShellState.ts"));
const seamCode  = stripComments(read("components/space/shell/useSpaceUrl.ts"));

// ── SD-0A: window.history writes live ONLY in the seam ──────────────────────────
const HISTORY_WRITE = /history\.(pushState|replaceState)/;
check("SpaceDashboard performs no direct window.history manipulation", !HISTORY_WRITE.test(dashCode));
check("shell time hook performs no direct window.history manipulation", !HISTORY_WRITE.test(shellCode));
check("useSpaceUrl IS the history writer (push + replace)", /history\.pushState/.test(seamCode) && /history\.replaceState/.test(seamCode));

// ── SD-0A: exactly one popstate listener — in the seam ──────────────────────────
const POPSTATE = /addEventListener\(\s*["']popstate["']/;
check("SpaceDashboard registers no popstate listener", !POPSTATE.test(dashCode));
check("shell time hook registers no popstate listener", !POPSTATE.test(shellCode));
check("useSpaceUrl owns the single popstate listener", POPSTATE.test(seamCode));

// ── SD-0A: consumers route through the canonical authority ──────────────────────
check("SpaceDashboard uses the canonical authority (useSpaceUrl.commit/subscribe)",
  /useSpaceUrl\(\)/.test(dashCode) && /spaceUrl\.commit\(/.test(dashCode) && /spaceUrl\.subscribe\(/.test(dashCode));
check("shell time hook uses the canonical authority (useSpaceUrl.commit/subscribe)",
  /useSpaceUrl\(\)/.test(shellCode) && /spaceUrl\.commit\(/.test(shellCode) && /spaceUrl\.subscribe\(/.test(shellCode));

// ── SD-0A: SSR invariant preserved — no useSearchParams in the shell path ───────
// (The Transaction drawer remains the one Suspense-bounded useSearchParams reader;
//  it lives in useTransactionDrawer.ts / DashboardChrome, not here.)
check("SpaceDashboard still avoids useSearchParams (no new Suspense boundary)", !dashCode.includes("useSearchParams"));
check("shell time hook avoids useSearchParams", !shellCode.includes("useSearchParams"));
check("useSpaceUrl avoids useSearchParams", !seamCode.includes("useSearchParams"));

// ── SD-0A: the drawer opener serializes through the shared core (no clobber) ────
const drawerCode = stripComments(read("components/transactions/useTransactionDrawer.ts"));
check("drawer opener serializes through the shared core (buildSpaceUrl)",
  /buildSpaceUrl\(pathname, search,/.test(drawerCode) && !/router\.push\(`\$\{pathname\}\?/.test(drawerCode));

// ── SD-0B: no second mutable cashFlowPeriod state; it is derived ────────────────
check("cashFlowPeriod is not a useState cell (no [cashFlowPeriod, setter])", !/\[\s*cashFlowPeriod\s*,/.test(dashCode));
check("no setCashFlowPeriod bridge writer remains", !/setCashFlowPeriod\b/.test(dashCode));
check("cashFlowPeriod is a const derived from the canonical shell slice",
  /const cashFlowPeriod: CashFlowPeriod\s*=/.test(dashCode) && /shell\.derived\.cashFlowPeriod/.test(dashCode));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-0A / SD-0B authority ratchets passed.");
