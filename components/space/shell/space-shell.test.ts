/**
 * components/space/shell/space-shell.test.ts
 *
 * SD-1 ratchets (source-scan — no DOM runner exists in this repo).
 *   npx tsx components/space/shell/space-shell.test.ts
 *
 * Pins the SpaceShell extraction: the shell owns the permanent frame (container,
 * header, toolbar slot, navigation rail, workspace slot) and is WORKSPACE-
 * AGNOSTIC; SpaceDashboard composes the shell instead of owning the frame; and
 * the SD-0 URL/time authorities are untouched.
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
/** Strip comments so prose that names a workspace doesn't trip a code ratchet. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const shellSrc  = read("components/space/shell/SpaceShell.tsx");
const shellCode = stripComments(shellSrc);
const dashSrc   = read("components/dashboard/SpaceDashboard.tsx");
const dashCode  = stripComments(dashSrc);

// ── SpaceShell OWNS the permanent frame ─────────────────────────────────────────
check("shell owns the frame container (max-w-5xl, centered)", /max-w-5xl mx-auto/.test(shellCode));
check("shell owns the Space-level rail (SegmentedControl)", /<SegmentedControl/.test(shellCode));
check("shell owns the rail float/static behavior (FloatingNavWrapper + railStatic)",
  /<FloatingNavWrapper/.test(shellCode) && /railStatic/.test(shellCode));
check("shell renders the header (title + subtitle)", /\{title\}/.test(shellCode) && /\{subtitle\}/.test(shellCode));
check("shell renders the toolbar slot", /\{toolbar\}/.test(shellCode));
check("shell renders the overlays slot (dialog mount point)", /\{overlays\}/.test(shellCode));
check("shell renders the workspace slot ({children})", /\{children\}/.test(shellCode));
check("shell exposes the slot API", /overlays\?:/.test(shellCode) && /toolbar\?:/.test(shellCode) &&
  /railOptions:/.test(shellCode) && /children:/.test(shellCode));

// ── SpaceShell is WORKSPACE-AGNOSTIC ────────────────────────────────────────────
// Nothing in the shell's code (comments stripped) may name a workspace or its
// composition primitives — it only knows "frame".
for (const banned of [
  "WealthPerspective", "InvestmentsPerspective", "DebtPerspective",
  "LiquidityPerspective", "CashFlowPerspective", "PerspectiveShell",
  "SectionCard", "SpaceTrendHero", "useInvestmentsTimeMachine",
  "computeWealthTimeMachine", "cashFlowPeriod", "currency", "ViewCurrencyOverride",
]) {
  check(`shell does not know workspace concern: ${banned}`, !shellCode.includes(banned));
}

// ── SpaceShell does NOT touch the SD-0 authorities ──────────────────────────────
check("shell does not touch the URL authority", !shellCode.includes("useSpaceUrl") && !/history\.(push|replace)State/.test(shellCode));
check("shell does not touch the time authority", !shellCode.includes("usePerspectiveShellState"));

// ── SpaceDashboard COMPOSES the shell instead of owning the frame ───────────────
check("host renders the SpaceShell frame", /<SpaceShell/.test(dashCode));
check("host no longer owns the frame container", !/max-w-5xl mx-auto/.test(dashCode));
check("host no longer imports the rail primitives directly",
  !/from "@\/components\/atlas\/SegmentedControl"/.test(dashCode) &&
  !/from "@\/components\/atlas\/FloatingNavWrapper"/.test(dashCode));
check("host feeds the rail (railOptions/activeTab/onSelectTab/railStatic)",
  /railOptions=\{railOptions\}/.test(dashCode) && /onSelectTab=\{setActiveTab\}/.test(dashCode) &&
  /railStatic=\{activeTab === "PERSPECTIVES"\}/.test(dashCode));

// ── Workspaces still render INSIDE the slot (host keeps workspace ownership) ─────
check("workspace render ladder still lives in the host (inside the slot)",
  /<WealthPerspective/.test(dashCode) && /<InvestmentsPerspective/.test(dashCode) &&
  /<CashFlowPerspectiveWorkspace/.test(dashCode) && /<DebtPerspective/.test(dashCode));

// ── SD-0 authorities preserved in the host (SD-1 must not regress them) ─────────
check("host still owns the URL authority (SD-0A)", /useSpaceUrl\(\)/.test(dashCode));
check("host still owns the time authority (SD-0B)", /usePerspectiveShellState\(/.test(dashCode));
check("host still avoids useSearchParams (no new Suspense boundary)", !dashCode.includes("useSearchParams"));

// ── FX ownership: the 'view as' control stays a host-provided body slot ─────────
check("FX control remains a host-threaded slot (overviewTopSlot)", /overviewTopSlot/.test(dashCode));
check("shell owns no FX/currency logic", !shellCode.includes("overviewTopSlot"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-1 SpaceShell ratchets passed.");
