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
// SD-8b — the host's tab/perspective/metric URL routing moved into
// useSpaceNavigation; the host now delegates to it and touches no URL directly.
const navCode = stripComments(read("lib/space/use-space-navigation.ts"));
check("navigation hook uses the canonical authority (useSpaceUrl.commit/subscribe)",
  /useSpaceUrl\(\)/.test(navCode) && /spaceUrl\.commit\(/.test(navCode) && /spaceUrl\.subscribe\(/.test(navCode));
check("SpaceDashboard routes navigation through useSpaceNavigation (no direct URL authority)",
  dashCode.includes("useSpaceNavigation(") && !/useSpaceUrl\(\)/.test(dashCode));
check("shell time hook uses the canonical authority (useSpaceUrl.commit/subscribe)",
  /useSpaceUrl\(\)/.test(shellCode) && /spaceUrl\.commit\(/.test(shellCode) && /spaceUrl\.subscribe\(/.test(shellCode));

// ── UX-P1 Change A: the PLATFORM host routes through the same seam ─────────────
// PlatformSpaceDashboard's open workspace is URL state (`?workspace=`), owned by
// usePlatformWorkspaceNavigation — which, like useSpaceNavigation, writes ONLY
// through useSpaceUrl. Neither the host nor the hook touches window.history or
// registers a popstate listener; only useSpaceUrl writes history.
const platCode    = stripComments(read("components/platform/PlatformSpaceDashboard.tsx"));
const platNavCode = stripComments(read("lib/space/use-platform-workspace-navigation.ts"));
check("PlatformSpaceDashboard performs no direct window.history manipulation", !HISTORY_WRITE.test(platCode));
check("PlatformSpaceDashboard registers no popstate listener", !POPSTATE.test(platCode));
check("PlatformSpaceDashboard routes navigation through usePlatformWorkspaceNavigation (no direct URL authority, no useState rail)",
  platCode.includes("usePlatformWorkspaceNavigation(") && !/useSpaceUrl\(\)/.test(platCode) && !/useState</.test(platCode));
check("platform navigation hook performs no direct window.history manipulation", !HISTORY_WRITE.test(platNavCode));
check("platform navigation hook registers no popstate listener", !POPSTATE.test(platNavCode));
check("platform navigation hook uses the canonical authority (useSpaceUrl.commit/subscribe)",
  /useSpaceUrl\(\)/.test(platNavCode) && /spaceUrl\.commit\(/.test(platNavCode) && /spaceUrl\.subscribe\(/.test(platNavCode));
check("platform navigation hook serializes through the shared core (buildSpaceUrl / readSpaceParam)",
  /from "@\/lib\/space\/space-url"/.test(platNavCode) && /buildSpaceUrl\(/.test(platNavCode) && /readSpaceParam\(/.test(platNavCode));
check("platform navigation hook DECLARES history intent (push on user change; replace on hydration/popstate)",
  /historyIntent\.current = "push"/.test(platNavCode) && /historyIntent\.current = "replace"/.test(platNavCode) &&
    /\{ history \}/.test(platNavCode));
check("PlatformSpaceDashboard avoids useSearchParams (no new Suspense boundary)", !platCode.includes("useSearchParams"));
check("platform navigation hook avoids useSearchParams", !platNavCode.includes("useSearchParams"));

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
// v2.7 — whole-identifier match: the reset wire `onResetCashFlowPeriod` contains
// the letters "setCashFlowPeriod" but is not a setter; the guard is about the
// removed `setCashFlowPeriod` state setter only.
check("no setCashFlowPeriod bridge writer remains", !/(?<![A-Za-z0-9_])setCashFlowPeriod\b/.test(dashCode));
// v2.7 — derived by the shell hook from the ACTIVE time group (shell.period: the
// explicit calendar unit, else the preset, else the group's last relative preset).
check("cashFlowPeriod is a const derived from the canonical shell slice",
  /const cashFlowPeriod: CashFlowPeriod\s*=\s*shell\.period;/.test(dashCode));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-0A / SD-0B authority ratchets passed.");
