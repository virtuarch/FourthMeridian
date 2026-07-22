/**
 * components/dashboard/widgets/transactions/transactions-redesign.test.ts
 *
 * Transactions EXPLORER — source-scan contract (house convention, no RTL;
 * run with `npx tsx components/dashboard/widgets/transactions/transactions-redesign.test.ts`).
 *
 * TX-3.3 rewrote what this file guards. It used to pin that the panel ran a complete
 * CLIENT query engine (filter → sort → slice) over one fetched array. That engine is
 * gone: the server now answers the question. So these checks pin the NEW invariants —
 * above all that the browser never becomes the browsing authority again — plus the
 * UI capabilities that legitimately survived the cutover.
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
/** Comment-stripped, so prose about a removed feature can never satisfy a check. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

const panel   = code("components/dashboard/widgets/SpaceTransactionsPanel.tsx");
const consts  = read(`${dir}/transactions-filter-constants.ts`);
const overlay = code(`${dir}/TransactionsFilterOverlay.tsx`);
const chips   = code(`${dir}/TransactionFilterChips.tsx`);
const pills   = code(`${dir}/QuickFlowPills.tsx`);
const menu    = code(`${dir}/ToolbarMenuButton.tsx`);
const hook    = code(`${dir}/useTransactionExplorer.ts`);

function main(): void {
  console.log("THE CORE INVARIANT — the browser is not the browsing authority");
  // The panel must not run a query engine over the rows the server returned.
  check("panel does not filter rows client-side", !/\brows\.filter\(/.test(panel));
  check("panel does not sort rows client-side", !/\brows\.sort\(|\.sort\(\(a, b\)/.test(panel));
  check("panel does not slice rows into pages client-side", !/\brows\.slice\(/.test(panel));
  check("panel holds no full-array `transactions` prop any more",
    !/transactions:\s*Transaction\[\]/.test(panel));
  check("panel takes the Space identity and queries the server itself",
    /spaceId:\s*string/.test(panel) && panel.includes("useTransactionExplorer(spaceId"));
  check("the hook itself filters/sorts nothing (it only accumulates pages)",
    !/\.filter\(\(?\s*(tx|t|row)\b/.test(hook) && !/\.sort\(\(a, b\)/.test(hook));

  console.log("\nSERVER QUERY — every surviving filter is a validated query param");
  for (const [state, param] of [
    ["catFilter", "category: catFilter"],
    ["flowFilter", "flowType: flowFilter"],
    ["accountFilter", "accountId: accountFilter"],
    ["sourceFilter", "source: sourceFilter"],
    ["pendingFilter", "pending: pendingFilter"],
    ["merchantId", "merchantId,"],
  ] as const) {
    check(`${state} is wired into the server query (${param})`, panel.includes(param));
  }
  check("search is debounced before it becomes a server query", /setTimeout\(\(\) => setSearch/.test(panel));
  check("date range resolves to explicit dateFrom/dateTo bounds",
    panel.includes("rangeBounds(") && /dateFrom:\s*from/.test(panel) && /dateTo:\s*to/.test(panel));
  check("the query carries no Perspective time (no preset/asOf/compareTo)",
    !/\bpreset\b/.test(panel) && !/\basOf\b/.test(panel) && !/compareTo/.test(panel));

  console.log("\nKEYSET PAGING — forward-only, opaque cursor, reset-aware");
  check("hook pages with an opaque cursor it never constructs", hook.includes('p.set("cursor", cursor)'));
  check("no offset/page-number paging anywhere in the panel",
    !/paginationRange|pageSize|totalPages|currentPage/.test(panel));
  check("hook honors cursorReset by REPLACING, not appending (M2)",
    /cursorReset === true/.test(hook) && /replace \? incoming/.test(hook));
  check("hook dedupes appended rows by id (M4 — mutable sort keys)",
    hook.includes("appendDeduped"));
  check("infinite scroll is wired to a sentinel", panel.includes("IntersectionObserver"));
  check("an explicit Load more control exists (keyboard/a11y fallback)",
    panel.includes("Load more"));
  check("a stale response cannot overwrite a newer question", hook.includes("activeKey.current !== forKey"));

  console.log("\nHONEST ANSWER SIZE — the count comes from the server, not from the page");
  check("panel renders the server count, not rows.length, as the answer size",
    /count\.toLocaleString\(\)/.test(panel));
  check("panel derives no money totals of its own (analytics are not the explorer's authority)",
    !panel.includes("sumByFlowType") && !/convertMoney/.test(panel));

  console.log("\nREMOVED BY DESIGN — client-derived analytics and unsupported sorts");
  // NB: `groupByDay` (presentation — bucketing the server's ALREADY-ORDERED rows
  // under day headers) is not a pivot and stays. What must not return is the
  // client GroupBy PIVOT over flow/merchant/account/category.
  check("no Group By pivot", !/\bsetGroupBy\b|\bGroupBy\b|GROUP_BY_LABELS/.test(panel));
  check("no Calendar heat-map view", !/CalendarHeatmap|SegmentedControl/.test(panel));
  check("no largest/smallest/merchant sorts (see TX3_1B §2)",
    !/"largest"|"smallest"/.test(panel) && /\["newest", "oldest"\]/.test(panel));
  check("no transferDisposition / needsClassification filters (derived, never persisted)",
    !/dispositionFilter|needsReviewOnly/.test(panel) && !/dispositionFilter|needsReviewOnly/.test(overlay));

  console.log("\nPRESERVED — the capabilities that legitimately survived");
  check("shared constants remain the single source", consts.includes("export const BANKING_CATEGORIES"));
  for (const setter of ["setCatFilter", "setFlowFilter", "setAccountFilter", "setSourceFilter", "setPendingFilter"]) {
    check(`overlay still wires ${setter}`, overlay.includes(setter));
  }
  check("overlay footer 'Show N' button only dismisses", /Show \{resultCount/.test(overlay));
  check("overlay introduces no local state (cannot stage a filter)", !/\buseState\b/.test(overlay));
  check("pills drive the SAME flowFilter", panel.includes("QuickFlowPills value={flowFilter} onChange={setFlowFilter}"));
  for (const flow of ["INCOME", "SPENDING", "TRANSFER", "DEBT_PAYMENT", "REFUND", "FEE"]) {
    check(`pills expose ${flow}`, pills.includes(`"${flow}"`));
  }
  check("pills include an All (null) reset", pills.includes("id: null"));
  for (const r of ['"all"', '"90d"', '"30d"', '"7d"', '"custom"']) {
    check(`DateRange includes ${r}`, panel.includes(r));
  }
  check("custom window still bounds by customStart/customEnd",
    panel.includes("customStart") && panel.includes("customEnd"));
  check("Filters surface still uses OverlaySurface", overlay.includes("OverlaySurface"));
  check("toolbar menu popover is still the shared component", menu.includes("menuitemradio"));
  check("active chips still live in their own component", chips.includes("Active filters:"));
  check("rows still open the shared detail drawer (URL-driven selection)",
    panel.includes("useOpenTransaction") && panel.includes("openTransaction(tx.id)"));
  check("the editorial day-grouped ledger survives", panel.includes("formatDayHeader"));

  console.log("\nINSPECT → QUERY — the merchant pivot the DTO's merchantId enables");
  check("a row can pivot the question to its merchant", panel.includes("onPivotMerchant"));
  check("the pivot filters on the resolved Merchant id, not a display name",
    /onPivotMerchant!\(tx\.merchantId!/.test(panel));
  check("the pivot does not open the drawer (stops propagation)", panel.includes("e.stopPropagation()"));
  check("an active merchant pivot is dismissible from the chips", chips.includes("onClearMerchant"));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll explorer invariants hold.");
}

main();
