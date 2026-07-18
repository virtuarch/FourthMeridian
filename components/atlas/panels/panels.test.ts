/**
 * components/atlas/panels/panels.test.ts
 *
 * Invariants for the Atlas panel primitive family. Two kinds of check:
 *   1. a REAL behavior test of the pure stacking allocator (createDepthAllocator);
 *   2. source-scan invariants for the behavior contract + the OWNERSHIP GUARD —
 *      panels are presentation primitives and must never import a domain.
 *
 * Pure, DB-free:  npx tsx components/atlas/panels/panels.test.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createDepthAllocator } from "./PanelStack";

const DIR = __dirname;
const read = (rel: string) => readFileSync(path.join(DIR, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""); // drop comments

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  failures++;
}

// ── 1. Stacking allocator — real behavior ──────────────────────────────────────────
console.log("1. Stacking allocator (createDepthAllocator)");
{
  const a = createDepthAllocator();
  check("first three acquires are 0,1,2 (ordered concurrent opens)",
    a.acquire() === 0 && a.acquire() === 1 && a.acquire() === 2);
  a.release(1);
  check("release then acquire reuses the smallest freed slot (→1)", a.acquire() === 1);
  a.release(0); a.release(1); a.release(2);
  check("after releasing all, next acquire returns to 0", a.acquire() === 0);
  const b = createDepthAllocator();
  check("each stack instance is independent", b.acquire() === 0);
}

// ── 2. Ownership guard — panels import no domain ───────────────────────────────────
console.log("2. Ownership guard — panels are presentation-only");
{
  const files = readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
  // Every import must resolve to an allowlisted source: react, react-dom, lucide-react,
  // an Atlas primitive, or a sibling file. Anything else (a lib/, a domain component)
  // is a leak.
  const allowed = (src: string) =>
    src === "react" || src === "react-dom" || src.startsWith("react/") ||
    src === "lucide-react" ||
    src.startsWith("@/components/atlas/") ||
    src.startsWith("./") || src.startsWith("../");
  for (const f of files) {
    const src = read(f);
    const imports = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const bad = imports.filter((s) => !allowed(s));
    check(`${f} imports only Atlas/React/siblings`, bad.length === 0, bad.join(", "));
    // Belt-and-suspenders: no domain or lib module, no workspace/dashboard component.
    check(`${f} imports no @/lib/* (no finance/data authority)`, !/from\s+["']@\/lib\//.test(src));
    check(`${f} imports no space/dashboard workspace component`,
      !/@\/components\/(space|dashboard)\//.test(src));
  }
  // No domain-named panel component may live here (those belong to their domain).
  const domainName = /(transaction|investment|holding|wealth|debt|liquidity|portfolio|account|brief)/i;
  const domainFiles = files.filter((f) => domainName.test(f));
  check("no domain-named panel file in the primitive dir", domainFiles.length === 0, domainFiles.join(", "));
}

// ── 3. Panel behavior contract (source-scan) ───────────────────────────────────────
console.log("3. Panel behavior contract");
{
  const P = strip(read("Panel.tsx"));
  // open / close / exit animation
  check("mounts through its exit animation (usePresence)", P.includes("usePresence(open"));
  check("unmounts when closed + not animating", P.includes("if (!mounted"));
  check("portals to the document body", P.includes("createPortal(") && P.includes("document.body"));
  // accessibility
  check('is a dialog (role="dialog" + aria-modal)', P.includes('role="dialog"') && P.includes('aria-modal="true"'));
  check("labels by header title or falls back to ariaLabel",
    P.includes("aria-labelledby=") && P.includes("aria-label="));
  check("traps Tab focus, captures + restores + auto-focuses",
    P.includes("useFocusTrap(") && P.includes("useReturnFocus(") && P.includes("useAutoFocus("));
  // keyboard escape (guarded)
  check("escape-to-close, guarded by preventClose", P.includes("useEscapeKey(open, onClose, preventClose)"));
  check("scrim click closes, guarded by preventClose", P.includes("closeOnScrim && !preventClose"));
  // reuse — not a second behavior language
  check("reuses GlassPanel material", P.includes('from "@/components/atlas/GlassPanel"'));
  check("reuses the shared overlay behavior + scroll lock",
    P.includes('from "@/components/atlas/useOverlayBehavior"') &&
    P.includes('from "@/components/atlas/useBodyScrollLock"'));
  // responsive — one component, CSS-driven (mobile sheet vs desktop docked)
  check("mobile bottom sheet (rounded top + grab handle) vs desktop docked (sm:)",
    P.includes("!rounded-t-") && P.includes("sm:hidden") && P.includes("sm:h-dvh"));
  // edge semantics — left vs right differ
  check("left vs right differ (scrim + dock side)", P.includes('side === "left"') && P.includes("left ? "));
  // stacking
  check("participates in PanelStack for z-layering", P.includes("usePanelStack(") && P.includes("Z_PANEL_BASE"));
}

// ── 4. Presets + composition + barrel ──────────────────────────────────────────────
console.log("4. Presets, composition slots, barrel");
{
  const S = strip(read("SidePanels.tsx"));
  check("LeftPanel fixes side=left, RightPanel fixes side=right",
    S.includes('side="left"') && S.includes('side="right"'));

  const parts = strip(read("PanelParts.tsx"));
  check("PanelHeader wires close + registers the title for aria-labelledby",
    parts.includes("onClose") && parts.includes("registerTitle(true)") && parts.includes("id={titleId}"));
  check("PanelContent is the single scroll region", parts.includes("overflow-y-auto") && parts.includes("flex-1"));

  const idx = strip(read("index.ts"));
  for (const sym of ["Panel", "LeftPanel", "RightPanel", "PanelHeader", "PanelContent", "PanelFooter", "PanelStack", "WorkspaceLayout"]) {
    check(`barrel exports ${sym}`, idx.includes(sym));
  }
}

// ── 5. No duplicate overlay behavior — OverlaySurface converged onto the shared home ─
console.log("5. Shared behavior — modal + panel use ONE implementation");
{
  const overlay = read("../OverlaySurface.tsx");
  check("OverlaySurface consumes the shared useOverlayBehavior",
    overlay.includes('from "@/components/atlas/useOverlayBehavior"'));
  check("OverlaySurface no longer defines its own reduced-motion hook",
    !overlay.includes("function usePrefersReducedMotion"));
  check("OverlaySurface no longer defines its own FOCUSABLE selector",
    !/const FOCUSABLE\s*=/.test(overlay));
  check("OverlaySurface uses the shared focus trap", overlay.includes("useFocusTrap("));
}

if (failures > 0) {
  console.error(`\n${failures} panel check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Atlas panel invariants hold.");
