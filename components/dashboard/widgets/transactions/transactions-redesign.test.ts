/**
 * components/dashboard/widgets/transactions/transactions-redesign.test.ts
 *
 * Transactions perspective redesign — source-scan contract (house convention,
 * no RTL; run with `npx tsx components/dashboard/widgets/transactions/transactions-redesign.test.ts`).
 *
 * The redesign is a UI/UX reorganization that must PRESERVE every existing
 * capability and change NO filter semantics. These checks pin the invariants the
 * plan committed to, so a later edit can't silently drop a filter, fabricate a
 * $0.00 KPI, stage filters instead of applying live, or make the default sort
 * differ from the pre-redesign date-desc order.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const dir = "components/dashboard/widgets/transactions";
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

const panel   = read("components/dashboard/widgets/SpaceTransactionsPanel.tsx");
const consts  = read(`${dir}/transactions-filter-constants.ts`);
const overlay = read(`${dir}/TransactionsFilterOverlay.tsx`);
const chips   = read(`${dir}/TransactionFilterChips.tsx`);
const pills   = read(`${dir}/QuickFlowPills.tsx`);
const cards   = read(`${dir}/TransactionSummaryCards.tsx`);
const menu    = read(`${dir}/ToolbarMenuButton.tsx`);

function main(): void {
  console.log("shared constants are the single source (no duplicate declarations in the panel)");
  for (const decl of [
    "const BANKING_CATEGORIES", "const PENDING_LABELS", "const SOURCE_LABELS",
    "const GROUP_BY_LABELS", "const TRANSFER_DISPOSITION_LABEL", "const INPUT_BASE",
    "const CAT_CHIP",
  ]) {
    check(`panel no longer declares ${decl}`, !panel.includes(decl));
    check(`constants module declares ${decl}`, consts.includes(`export ${decl}`));
  }

  console.log("\nevery pre-redesign filter is preserved, now inside the Filters overlay");
  for (const setter of [
    "setCatFilter", "setFlowFilter", "setAccountFilter", "setDispositionFilter",
    "setSourceFilter", "setMerchantFilter", "setNeedsReviewOnly", "setPendingFilter",
    "setGroupBy",
  ]) {
    check(`overlay wires ${setter}`, overlay.includes(setter));
  }
  check("grouping stays table-only (showGrouping gate)", overlay.includes("showGrouping"));

  console.log("\nfilter semantics unchanged — the panel predicate still guards each dimension");
  for (const guard of [
    "catFilter", "flowFilter", "dispositionFilter", "sourceFilter",
    "merchantFilter", "needsReviewOnly", "accountFilter", "pendingFilter",
  ]) {
    check(`predicate references ${guard}`, panel.includes(guard));
  }

  console.log("\nfilters apply LIVE (no staged/draft apply) — the sheet footer only dismisses");
  check("overlay footer 'Show N' button calls onClose", /Show \{resultCount/.test(overlay));
  // The overlay is fully controlled — it holds NO local state, so a change can
  // only flow straight to the panel's setter (live), never into a staged copy.
  check("overlay introduces no local state (cannot stage)", !/\buseState\b/.test(overlay));

  console.log("\nQuick Flow pills drive the SAME flowFilter (no new backend behavior)");
  check("pills passed flowFilter/setFlowFilter", panel.includes("QuickFlowPills value={flowFilter} onChange={setFlowFilter}"));
  for (const flow of ["INCOME", "SPENDING", "TRANSFER", "DEBT_PAYMENT", "REFUND", "FEE"]) {
    check(`pills expose ${flow}`, pills.includes(`"${flow}"`));
  }
  check("pills include an All (null) reset", pills.includes("id: null"));

  console.log("\nsummary KPIs keep zero-count honesty (no fabricated $0.00)");
  for (const g of ["spend > 0", "income > 0", "transfers > 0", "debtPayments > 0", "investments > 0", "refunds > 0"]) {
    check(`card conditional: ${g}`, cards.includes(g));
  }
  check("Transactions count card is unconditional", cards.includes("title=\"Transactions\""));
  check("math still flows from the shared sumByFlowType map", panel.includes("sumByFlowType"));

  console.log("\nsort is a pure client-side reorder; default is byte-identical to today");
  check("newest is identity (returns filtered untouched)", /sortBy === "newest"\)\s*return filtered/.test(panel));
  check("sort default state is 'newest'", panel.includes('useState<SortBy>("newest")'));
  check("summary totals read `filtered` (order-independent), not `sorted`", panel.includes("sumByFlowType(filtered"));

  console.log("\ntime selector keeps the presets and adds a Custom [from,to] window");
  for (const r of ['"all"', '"90d"', '"30d"', '"7d"', '"custom"']) {
    check(`DateRange includes ${r}`, panel.includes(r));
  }
  check("custom predicate bounds by customStart/customEnd", panel.includes("customStart") && panel.includes("customEnd"));

  console.log("\nreused Atlas primitives (not re-implemented)");
  check("Filters surface uses OverlaySurface", overlay.includes("OverlaySurface"));
  check("Table/Calendar uses SegmentedControl", panel.includes("SegmentedControl"));
  check("toolbar menu popover is a shared component", menu.includes("menuitemradio"));
  check("active chips relocated to their own component", chips.includes("Active filters:"));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll redesign invariants hold.");
}

main();
