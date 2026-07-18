/**
 * components/space/shell/space-shell.test.ts
 *
 * SD-1 seam tripwires + slot-API contract.
 *
 * Two gates run over this one file:
 *   • RUNTIME (this tsx run) — the durable BOUNDARY scans: the shell imports NO
 *     domain business logic, does NO FX math, and touches NO competing URL/time
 *     authority; the host composes the shell and keeps the SD-0 authorities.
 *   • COMPILE-TIME (`tsc --noEmit`, which scans test files) — the SpaceShellProps
 *     SLOT API (workspace / header / toolbar / overlays / rail / display-currency
 *     slots). This replaces the former brittle JSX-text, max-width-class, and
 *     prop-spelling pins: a diverging edit to the props shape fails `tsc`, and a
 *     cosmetic layout refactor (that changes nothing observable) no longer does.
 *
 *   npx tsx components/space/shell/space-shell.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import type { SpaceShellProps, SpaceShellRailOption } from "./SpaceShell";

// ── TYPE-LEVEL: the SpaceShell slot API (compile-time; tsc is the gate) ──────────
// Each slot is a host-composed ReactNode — the shell owns only WHERE it mounts,
// never WHAT it renders. This is a slot API a runtime test can't cheaply reach in
// this no-DOM repo, so it is asserted structurally instead of by scanning JSX text.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// The workspace viewport slot — the active tab's body, supplied by the host.
type _WorkspaceSlot = Expect<Equal<SpaceShellProps["children"], ReactNode>>;
// Header slots.
type _TitleSlot    = Expect<Equal<SpaceShellProps["title"], ReactNode>>;
type _SubtitleSlot = Expect<Equal<SpaceShellProps["subtitle"], ReactNode>>;
// Optional host-composed chrome slots (a slot, never structured props — the shell
// stays agnostic of what each one opens or renders).
type _OverlaysSlot = Expect<Equal<SpaceShellProps["overlays"], ReactNode | undefined>>;
// SHELL migration — the identity, the FX control, and Manage now live in the
// ContextualNavbar's Space mode (published via SpaceChrome). The shell keeps a
// SECOND, CSS-gated mount point for the canonical controls used at narrow widths
// (where the sidebar is hidden): the FX node is a ReactNode SLOT (the shell does
// NO FX), Manage is the host's handler. Optional (absent ⇒ nothing renders).
type _FxSlot     = Expect<Equal<SpaceShellProps["currencyControl"], ReactNode | undefined>>;
type _ManageSlot = Expect<Equal<SpaceShellProps["onManage"], (() => void) | undefined>>;
// The rail slot carries resolved id/label/icon options — never domain workspaces.
type _RailSlot   = Expect<Equal<SpaceShellProps["railOptions"], SpaceShellRailOption[]>>;
type _RailOption = Expect<Equal<keyof SpaceShellRailOption, "id" | "label" | "icon">>;
// The EXACT slot-API surface — nothing added, nothing dropped. Replaces the old
// text scan for `overlays?:` / `railOptions:` / `children:`.
// M3-Reset — `railStatic` removed: the rail is centered + stationary on every
// Workspace and lens. SHELL migration — `toolbar` + `displayCurrencyControl`
// dropped in favour of the ContextualNavbar-published identity/controls, with
// `currencyControl` + `onManage` retained here for the narrow-width relocation.
// UI-Convergence Wave 1 (D2) — `variant` ("space" default | "utility") + the
// utility-only `headerActions` slot let a GLOBAL-nav destination (Connections /
// Settings) reuse the frame without taking over the navbar. One prop, one branch.
type _SlotApiKeys = Expect<Equal<
  keyof SpaceShellProps,
  | "overlays" | "title" | "subtitle" | "currencyControl" | "onManage"
  | "railOptions" | "activeTab" | "onSelectTab" | "variant" | "headerActions" | "mobileOptimized" | "children"
>>;
// The variant discriminator + its optional header-actions slot.
type _Variant       = Expect<Equal<SpaceShellProps["variant"], "space" | "utility" | undefined>>;
type _HeaderActions = Expect<Equal<SpaceShellProps["headerActions"], ReactNode | undefined>>;

// ── RUNTIME: the durable boundary scans (source-scan — no DOM runner in-repo) ────
let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (!ok) { failures++; if (detail) console.log(`        ${detail}`); }
}

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, ...p.split("/")), "utf8");
/** Strip comments so prose that names a workspace doesn't trip a code ratchet. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const shellCode = stripComments(read("components/space/shell/SpaceShell.tsx"));
const dashCode  = stripComments(read("components/dashboard/SpaceDashboard.tsx"));

// ── DURABLE SEAM: SpaceShell is WORKSPACE-AGNOSTIC + does NO FX math ─────────────
// The load-bearing SD-1 invariant: nothing in the shell's code (comments stripped)
// may name a workspace, its composition primitives, or any currency/FX module.
// This is an import-graph boundary a runtime test cannot cheaply hold.
for (const banned of [
  "WealthWorkspace", "InvestmentsWorkspace", "DebtWorkspace",
  "LiquidityPerspective", "LiquidityWorkspace", "CashFlowPerspective", "CashFlowWorkspace", "PerspectiveShell",
  "SectionCard", "SpaceTrendHero", "useInvestmentsSpaceData",
  "computeWealthTimeMachine", "cashFlowPeriod",
  // SD-2C: the shell may own a display-currency *slot* (a ReactNode the host
  // supplies), but it must never build the control or do FX math itself.
  "ViewCurrencyOverride", "convertMoney", "formatCurrency",
  "@/lib/money", "@/lib/currency", "@/lib/fx", "DisplayCurrencyProvider",
]) {
  check(`shell does not import/perform workspace or FX logic: ${banned}`, !shellCode.includes(banned));
}

// ── DURABLE SEAM: SpaceShell does NOT touch the SD-0 authorities ─────────────────
check("shell does not touch the URL authority", !shellCode.includes("useSpaceUrl") && !/history\.(push|replace)State/.test(shellCode));
check("shell does not touch the time authority", !shellCode.includes("usePerspectiveShellState"));

// ── DURABLE SEAM: the host COMPOSES the shell and KEEPS the SD-0 authorities ─────
check("host composes the SpaceShell frame", /<SpaceShell/.test(dashCode));
// Single-authority: the rail primitives belong to the shell — the host must not
// import them directly (import-graph boundary, not a layout pin).
check("host does not import the rail primitives directly",
  !/from "@\/components\/atlas\/SegmentedControl"/.test(dashCode) &&
  !/from "@\/components\/atlas\/FloatingNavWrapper"/.test(dashCode));
// SD-8b — the URL authority moved into useSpaceNavigation; the host owns it by
// composing that hook (it stays OUT of the SpaceShell frame, which is the seam).
check("host owns the URL authority via useSpaceNavigation (SD-8b)", dashCode.includes("useSpaceNavigation("));
check("host still owns the time authority (SD-0B)", /usePerspectiveShellState\(/.test(dashCode));
check("host still avoids useSearchParams (no new Suspense boundary)", !dashCode.includes("useSearchParams"));

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll SD-1 SpaceShell seam + slot-API ratchets passed.");
