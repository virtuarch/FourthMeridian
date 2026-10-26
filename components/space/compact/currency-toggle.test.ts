/**
 * components/space/compact/currency-toggle.test.ts  (v2.7 — display-currency toggle)
 *
 * Owner rule: every monetary value inside a Space respects the Space display
 * currency. Presentation-only conversion through convertMoney / the existing
 * display helpers; the native figure stays as a quiet subline when foreign; an
 * unavailable rate never relabels a native figure.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/space/compact/currency-toggle.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ConversionContext } from "@/lib/money/types";
import { CreditUtilizationWidget, type DebtPerspectiveAccount } from "@/components/space/widgets/debt-perspective-adapters";
import { CreditLimitInputs, displayLimit } from "@/components/space/widgets/debt/CreditHealthInputs";
import { accountBalanceDisplay } from "@/components/space/manage/FinancesPanel";
import { eventAmountDisplay } from "@/components/space/widgets/activity/ActivityEventDetail";
import { realAssetValueDisplay } from "@/components/space/widgets/wealth/RealAssetsSection";
import { sliceRowMoney } from "@/components/space/widgets/TransactionSliceDrawer";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

/** EUR target; USD→EUR = 0.5 exactly (fresh), GBP walked back (estimated), JPY missing. */
const EUR_CTX: ConversionContext = {
  target: "EUR",
  resolve: (from, dateISO) => {
    if (from === "USD") return { kind: "rate", rate: 0.5, requestedDateISO: dateISO, effectiveDates: { from: dateISO, to: dateISO }, staleness: "exact" } as never;
    if (from === "GBP") return { kind: "rate", rate: 2, requestedDateISO: dateISO, effectiveDates: { from: "2020-01-01", to: dateISO }, staleness: "walked-back" } as never;
    return { kind: "miss", quote: from, requestedDateISO: dateISO };
  },
};

const card = (over: Partial<DebtPerspectiveAccount>): DebtPerspectiveAccount => ({
  id: "c1", name: "Visa", type: "debt", balance: 1000, currency: "USD", creditLimit: 4000, debtSubtype: "credit_card", ...over,
} as DebtPerspectiveAccount);

console.log("\n1. CreditUtilizationWidget — balance & limit in the display currency");
{
  const h = text(renderToStaticMarkup(createElement(CreditUtilizationWidget, { accounts: [card({})], ctx: EUR_CTX })));
  check("USD-native 1,000 of 4,000 renders as €500 of €2,000", /€500(\.00)? of €2,000(\.00)?/.test(h), h);
  check("utilization % stays the native ratio (25%)", h.includes("25%"), h);
  check("no USD figure claimed", !h.includes("$"), h);
  const miss = text(renderToStaticMarkup(createElement(CreditUtilizationWidget, { accounts: [card({ creditLimit: undefined })], ctx: EUR_CTX })));
  check("Add limit affordance present for a missing limit", miss.includes("Add limit"), miss);
  check("Add limit input is labelled with the account currency (source)", /placeholder=\{`Limit \(\$\{byId\.get\(m\.id\)\?\.currency/.test(read("components/space/widgets/debt-perspective-adapters.tsx")));
}

console.log("\n2. CreditLimitInputs — converted limit + native subline; native-labelled input");
{
  const h = text(renderToStaticMarkup(createElement(CreditLimitInputs, { accounts: [card({})], ctx: EUR_CTX })));
  check("limit shows €2,000 converted", /€2,000(\.00)? limit/.test(h), h);
  check("native $4,000 kept as subline", /\$4,000(\.00)?/.test(h), h);
  const same = displayLimit(4000, "EUR", EUR_CTX);
  check("same-currency limit: no subline", same.native === null && same.primary.includes("€4,000"));
  const gone = displayLimit(4000, "JPY", EUR_CTX);
  check("unavailable rate ⇒ native only, never relabelled", gone.native === null && !gone.primary.includes("€"), gone.primary);
  check("walked-back rate ⇒ ≈ marker", displayLimit(100, "GBP", EUR_CTX).primary.startsWith("≈ "));
  const src = code("components/space/widgets/debt/CreditHealthInputs.tsx");
  check("edit input placeholder/aria name the account currency", src.includes("placeholder={`Limit (${a.currency") && src.includes("in ${a.currency"));
  check("DebtWorkspace threads ctx into CreditLimitInputs", code("components/space/widgets/debt/DebtWorkspace.tsx").includes("<CreditLimitInputs accounts={accounts} ctx={ctx} />"));
}

console.log("\n3. DebtPayoffSection picker rows convert through inDisp");
{
  const src = code("components/space/sections/DebtPayoffSection.tsx");
  check("picker row uses inDisp(a.balance, a.currency)", src.includes("const r = inDisp(a.balance, a.currency);"));
  check("native subline kept when foreign", src.includes("foreign && !unavailable"));
}

console.log("\n4. Manage Space → Accounts balances");
{
  const d = accountBalanceDisplay(1000, "USD", EUR_CTX);
  check("USD 1,000 ⇒ €500 + native subline", /€500/.test(d.primary) && /\$1,000/.test(d.native ?? ""), JSON.stringify(d));
  check("no ctx ⇒ native", accountBalanceDisplay(1000, "USD").primary.includes("$1,000") && accountBalanceDisplay(1000, "USD").native === null);
  check("unavailable ⇒ native only", accountBalanceDisplay(1000, "JPY", EUR_CTX).native === null);
  check("SpaceDashboard → ManageSpaceModal ctx={widgetCtx}", code("components/dashboard/SpaceDashboard.tsx").includes("ctx={widgetCtx}"));
  check("ManageSpaceModal → FinancesPanel ctx", code("components/space/manage/ManageSpaceModal.tsx").includes("onRefresh={onRefresh} ctx={ctx} />"));
}

console.log("\n5. Transactions tab rows convert at their own date");
{
  const src = code("components/dashboard/widgets/SpaceTransactionsPanel.tsx");
  check("row converts via convertMoney at tx.date", src.includes("convertMoney({ amount: tx.amount, currency: tx.currency }, tx.date, ctx)"));
  check("missing-currency fallback = useDisplayCurrency, no DEFAULT_DISPLAY_CURRENCY", src.includes("useDisplayCurrency()") && !src.includes("DEFAULT_DISPLAY_CURRENCY"));
  check("SpaceDashboard threads txConversionCtx to TransactionsWorkspace", code("components/dashboard/SpaceDashboard.tsx").includes("ctx={txConversionCtx}"));
  check("TransactionsWorkspace → SpaceTransactionsPanel ctx", code("components/space/workspaces/TransactionsWorkspace.tsx").includes("ctx={ctx}"));
}

console.log("\n6. ActivityEventDetail amount at the event date");
{
  const d = eventAmountDisplay(200, "USD", "2026-10-01T12:00:00Z", EUR_CTX);
  check("USD 200 ⇒ €100 + native subline", /€100/.test(d.primary) && /\$200/.test(d.native ?? ""), JSON.stringify(d));
  let seen = "";
  eventAmountDisplay(1, "USD", "2026-09-03T08:00:00Z", { target: "EUR", resolve: (f, dt) => { seen = dt; return { kind: "miss", quote: f, requestedDateISO: dt }; } });
  check("converted at the event's own date", seen === "2026-09-03", seen);
  check("ActivityWorkspace receives ctx={widgetCtx}", code("components/dashboard/SpaceDashboard.tsx").includes("<ActivityWorkspace spaceId={spaceId} ctx={widgetCtx} />"));
}

console.log("\n7. No hard-USD fallbacks in touched files");
{
  for (const f of [
    "components/space/widgets/investments/InvestmentsBridgeCard.tsx",
    "components/space/widgets/investments/InvestmentsActivityCard.tsx",
    "components/space/widgets/wealth/WealthWorkspace.tsx",
    "components/space/widgets/wealth/RealAssetsSection.tsx",
    "components/dashboard/widgets/SpaceTransactionsPanel.tsx",
    "components/space/manage/FinancesPanel.tsx",
    "components/space/widgets/activity/ActivityEventDetail.tsx",
    "components/space/widgets/TransactionSliceDrawer.tsx",
    "components/space/widgets/debt/CreditHealthInputs.tsx",
  ]) check(`${path.basename(f)}: no ?? "USD"`, !/\?\?\s*"USD"/.test(code(f)));
}

console.log("\n8. Pinned presentation files — Real assets + slice drawer");
{
  const v = realAssetValueDisplay(300000, "USD", EUR_CTX);
  check("real asset USD 300,000 ⇒ €150,000 + native subline", /€150,000/.test(v.primary) && /\$300,000/.test(v.native ?? ""), JSON.stringify(v));
  check("WealthWorkspace threads ctx into RealAssetsSection", code("components/space/widgets/wealth/WealthWorkspace.tsx").includes("active={active} ctx={ctx} />"));
  let seen = "";
  const r = sliceRowMoney({ amount: -40, currency: "USD", date: "2026-08-15" }, "EUR", { target: "EUR", resolve: (f, dt) => { seen = dt; return EUR_CTX.resolve(f, dt); } });
  check("slice row USD −40 ⇒ €20 at the row date + native subline", /€20/.test(r.primary) && /\$40/.test(r.native ?? "") && seen === "2026-08-15", JSON.stringify(r));
  check("slice row with no currency ⇒ display currency, no subline", sliceRowMoney({ amount: 5, currency: null as never, date: "2026-08-15" }, "EUR").primary.includes("€"));

  // Exactly the two re-baselined hashes changed in unchanged-pins.json vs HEAD.
  let diff = "";
  try { diff = execSync("git diff HEAD -U0 -- components/space/compact/unchanged-pins.json", { cwd: ROOT, encoding: "utf8" }); } catch { /* no git */ }
  const removed = diff.split("\n").filter((l) => /^-\s/.test(l));
  const added   = diff.split("\n").filter((l) => /^\+\s/.test(l));
  const EXPECT = ["components/space/widgets/TransactionSliceDrawer.tsx", "components/space/widgets/wealth/RealAssetsSection.tsx"];
  if (diff) {
    check("pins diff: exactly two lines changed, both the sanctioned files",
      removed.length === 2 && added.length === 2 && EXPECT.every((f) => added.some((l) => l.includes(`"${f}"`))), diff);
  } else {
    // Committed — the recorded hashes must equal the current bytes of those two files.
    const pins = JSON.parse(read("components/space/compact/unchanged-pins.json")) as Record<string, string>;
    check("re-baselined pins match the two files", EXPECT.every((f) => pins[f] === createHash("sha256").update(readFileSync(path.join(ROOT, f))).digest("hex")));
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
