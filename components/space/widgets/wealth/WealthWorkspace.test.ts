/**
 * components/space/widgets/wealth/WealthWorkspace.test.ts  (SD-5)
 *
 * Source-scan ratchets for the Wealth WORKSPACE (pure, DB-free). Locks the SD-5
 * extraction contract:
 *   • WealthWorkspace is THE render + composition boundary (the five surfaces),
 *   • WealthResult (computeWealthTimeMachine) remains the canonical Wealth boundary —
 *     no WealthSpaceData wrapper was introduced,
 *   • the composition (computeWealthTimeMachine) + per-date display-currency FX + the
 *     trust envelope + the Evidence drawer moved OUT of the host INTO the Workspace,
 *   • canonical shell asOf/compareTo are props (no local time authority),
 *   • display currency is ACTIVATED: the snapshot series is converted per-date before
 *     the read model, and the workspace renders in the effective display currency,
 *   • snapshots stay a SHARED host-fetched prop (no second snapshot fetch/authority),
 *   • the trust envelope is bridged to the shell via onEnvelopeChange (Investments
 *     pattern), and the host no longer recomputes WealthResult.
 *
 *   npx tsx components/space/widgets/wealth/WealthWorkspace.test.ts
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = "components/space/widgets/wealth";
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const SRC   = read(`${DIR}/WealthWorkspace.tsx`);
const CODE  = strip(SRC);
const CONV  = read("lib/wealth/display-conversion.ts");
const CONVC = strip(CONV);
const TM    = strip(read("lib/wealth/wealth-time-machine.ts"));
const HOSTC = strip(read("components/dashboard/SpaceDashboard.tsx"));

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("1. Render boundary — the five Wealth surfaces in their fixed order");
{
  const order = ["<WealthHero", "<WealthTrendChart", "<WealthChangeLedger", "<WealthCompositionCard", "<WealthExplanationCard"];
  const pos = order.map((n) => SRC.indexOf(n));
  check("all five surfaces are composed here (this IS the render boundary)", pos.every((p) => p >= 0));
  check("surfaces appear in the mandated hierarchy", pos.every((p, i) => i === 0 || pos[i - 1] < p), pos.join(","));
  // A min-h on the backfill spinner placeholder is fine (a floor, not a clip); forbid
  // only fixed h-[…] / max-h-[…] that would clip the real content grid.
  check("no fixed h-[…]/max-h-[…] on the workspace layout (min-h loader allowed)", !SRC.replace(/min-h-\[/g, "").includes("h-["));
  check("columns are min-w-0 (no horizontal overflow)", CODE.includes("min-w-0") && CODE.includes("lg:grid-cols-12"));
  check("the old WealthPerspective render boundary is retired", !existsSync(path.join(ROOT, `${DIR}/WealthPerspective.tsx`)));
}

console.log("2. WealthResult is canonical — NO WealthSpaceData wrapper introduced");
{
  check("Workspace derives WealthResult via computeWealthTimeMachine", CODE.includes("computeWealthTimeMachine("));
  check("result typed as the canonical WealthResult", CODE.includes("WealthResult"));
  check("no WealthSpaceData contract exists in the tree", !CODE.includes("WealthSpaceData") && !HOSTC.includes("WealthSpaceData") && !existsSync(path.join(ROOT, "lib/wealth/wealth-space-data.ts")) && !existsSync(path.join(ROOT, "lib/wealth/space-data.ts")));
  check("no bespoke Wealth loader / route (WealthResult IS the boundary)", !CODE.includes("loadWealthSpaceData") && !CODE.includes("useWealthSpaceData"));
}

console.log("3. Data OWNERSHIP moved host → Workspace (no duplicate Wealth computation)");
{
  check("Workspace owns the composition (computeWealthTimeMachine)", CODE.includes("computeWealthTimeMachine("));
  check("host no longer computes WealthResult", !HOSTC.includes("computeWealthTimeMachine("));
  check("host retains no wealthResult / wealthCurrency", !HOSTC.includes("wealthResult") && !HOSTC.includes("wealthCurrency"));
  check("host mounts <WealthWorkspace> exactly once", (HOSTC.match(/<WealthWorkspace/g) || []).length === 1);
}

console.log("4. Canonical time — asOf/compareTo are PROPS; no local time authority");
{
  check("asOf + compareTo are inbound props (shell-owned)", CODE.includes("asOf") && CODE.includes("compareTo"));
  check("no local date state", !/useState<[^>]*>\(\s*["'][0-9]/.test(CODE) && !CODE.includes("setAsOf(") && !CODE.includes("setCompareTo("));
  check("no shell time authority inside the Workspace", !CODE.includes("usePerspectiveShellState") && !CODE.includes("useSpaceUrl"));
  check("no historical reconstruction in the Workspace (read model owns it)", !CODE.includes("getSnapshotAsOf") && !CODE.includes("resolveState"));
}

console.log("5. Display currency ACTIVATED — per-date FX before the read model");
{
  check("Workspace converts the SHARED snapshot series (convertWealthSnapshots)", CODE.includes("convertWealthSnapshots("));
  check("conversion feeds the read model (converted series → computeWealthTimeMachine)",
    CODE.includes("convertedSnapshots") && /computeWealthTimeMachine\(\{[\s\S]*convertedSnapshots/.test(CODE));
  check("read model receives the effective display currency", /currency:\s*displayCurrency/.test(CODE));
  check("per-date conversion (each row converted at its own s.date)", CONVC.includes("s.date") && CONVC.includes("convertMoney("));
  check("identity fast-path (from === target) returns the input unchanged", CONVC.includes("from === ctx.target") && CONVC.includes("return snapshots"));
  check("rate miss ⇒ mixed-unit honesty (row flagged fxMiss, not blended)", CONVC.includes("fxMiss: true"));
  check("stored snapshots never mutated (spread into new rows, no s.x = )", !/\bs\.(netWorth|totalAssets|totalDebt|totalCash|cashOnHand)\s*=/.test(CONVC));
  check("Time Machine still drops fxMiss (mixed-unit guard preserved)", TM.includes("fxMiss"));
}

console.log("6. Trust / envelope — resolved in the Workspace, bridged to the shell");
{
  check("Workspace resolves its own envelope via the canonical resolver", CODE.includes("resolvePerspectiveEnvelope(") && CODE.includes('perspectiveId: "wealth"'));
  check("Workspace emits the envelope up (onEnvelopeChange)", CODE.includes("onEnvelopeChange("));
  check("envelope resolved from the currency-consistent result", /resolvePerspectiveEnvelope\(\{[\s\S]*wealthResult: result/.test(CODE));
  check("host relays the Workspace envelope (setWealthEnvelope) to the shell", HOSTC.includes("onEnvelopeChange={setWealthEnvelope}") && HOSTC.includes("? wealthEnvelope"));
  check("Evidence drawer is now Workspace-owned (moved off the host)", CODE.includes("<EvidenceDrawer") && !HOSTC.includes("EvidenceDrawer"));
  check("no duplicate trust math (only the canonical resolver, no bespoke tiers)", !CODE.includes("completeness:") && !CODE.includes("tier:"));
}

console.log("7. No second snapshot authority — snapshots are a SHARED inbound prop");
{
  check("Workspace does NOT fetch (snapshots passed in as a prop)", !CODE.includes("fetch("));
  check("no ad hoc snapshot / DB read in the Workspace", !/prisma|@\/lib\/db|getRecentSnapshots|getSnapshots/.test(CODE));
  check("snapshots + snapshotCurrency are inbound props", CODE.includes("snapshots") && CODE.includes("snapshotCurrency"));
  check("host still fetches snapshots ONCE and shares them (Overview/Debt/Wealth)", HOSTC.includes("/snapshots") && HOSTC.includes("snapshots={snapshots}"));
}

if (failures > 0) { console.error(`\n${failures} WealthWorkspace check(s) failed`); process.exit(1); }
console.log("\nAll WealthWorkspace checks passed");
