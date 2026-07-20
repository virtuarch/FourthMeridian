/**
 * lib/transactions/coverage-note.test.ts  (TX-2A)
 *
 * Proves the transaction-completeness AWARENESS slice is honest and inert:
 *   - UNDER the cap (truncated=false) → coverageMessage is null → NO indicator.
 *   - OVER the cap (truncated=true)   → an honest message appears (browse/history).
 *   - The metadata is not silently discarded anywhere on the path
 *     (route → use-space-data → renderCtx → the three surfaces).
 *   - This slice touches NO financial calculation (presentation-only wiring).
 *
 * Standalone tsx (no DB, no React render):  npx tsx lib/transactions/coverage-note.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { coverageMessage } from "./coverage-note";

const ROOT = process.cwd();
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

console.log("UNDER the cap — a complete population shows NO indicator");
{
  check("truncated:false → null (browse)", coverageMessage({ truncated: false, limit: 5000 }, "browse") === null);
  check("truncated:false → null (history)", coverageMessage({ truncated: false, limit: 5000 }, "history") === null);
  check("null coverage → null", coverageMessage(null, "browse") === null);
  check("undefined coverage → null", coverageMessage(undefined, "history") === null);
}

console.log("OVER the cap — an honest message appears");
{
  const browse = coverageMessage({ truncated: true, limit: 5000 }, "browse");
  check("browse copy names the real cap", browse === "Showing the most recent 5,000 transactions.");
  const history = coverageMessage({ truncated: true, limit: 5000 }, "history");
  check("history copy is the muted completeness caveat",
    history === "Historical view is based on available transaction history. Some older transactions are not included.");
  check("browse default variant when omitted",
    coverageMessage({ truncated: true, limit: 5000 }) === "Showing the most recent 5,000 transactions.");
  check("browse degrades cleanly without a limit (no doubled phrasing)",
    coverageMessage({ truncated: true }, "browse") === "Showing your most recent transactions.");
}

console.log("PROPAGATION — the sentinel is not discarded on the path");
{
  const route = code("app/api/spaces/[id]/transactions/route.ts");
  check("route returns truncated + limit", /truncated,\s*limit/.test(route) && route.includes("limit"));

  const hook = code("lib/space/use-space-data.ts");
  check("use-space-data reads truncated off the payload", hook.includes("data?.truncated"));
  check("use-space-data exposes transactionsMeta", hook.includes("transactionsMeta"));
  check("use-space-data no longer silently drops the flag (sets meta in the tx fetch)",
    /setTransactionsMeta\(\{\s*truncated:/.test(hook));

  const host = code("components/dashboard/SpaceDashboard.tsx");
  check("host threads transactionsMeta into renderCtx", host.includes("transactionsMeta"));
  // TX-3.3 — the Transactions tab no longer receives transactionsMeta, and that is
  // the POINT: the explorer is server-paged over the full population, so it is not
  // capped and the "most recent N" caveat would be FALSE there. The flag still has
  // to reach the surfaces that DO read the capped array (Cash Flow, Liquidity),
  // which the renderer-ctx check below pins.
  check("host still threads transactionsMeta to the analytical consumers (render ctx)",
    /^\s*transactionsMeta,\s*$/m.test(host));

  const rend = code("components/space/workspaces/workspaceRenderers.tsx");
  check("renderer ctx carries transactionsMeta to Cash Flow + Liquidity",
    (rend.match(/transactionsMeta=\{ctx\.transactionsMeta\}/g) ?? []).length >= 2);
}

console.log("SURFACES — the note is gated on truncation, not always-on");
{
  const note = code("components/space/trust/TransactionCoverageNote.tsx");
  check("the note returns null when coverageMessage is null (no always-on warning)",
    note.includes("if (!message) return null"));

  // TX-3.3 — the Transactions EXPLORER must NOT render a coverage caveat: it pages
  // the full population via the keyset authority, so claiming "showing the most
  // recent N" would be a false admission. Inverted deliberately, so re-adding a
  // capped browse read to this surface without re-thinking the note fails here.
  const tx = code("components/space/workspaces/TransactionsWorkspace.tsx");
  check("Transactions explorer renders NO coverage note (it is not capped)",
    !/TransactionCoverageNote/.test(tx));
  const cf = code("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
  check("Cash Flow renders the history note", /TransactionCoverageNote[\s\S]*variant="history"/.test(cf));
  const lq = code("components/space/widgets/liquidity/LiquidityWorkspace.tsx");
  check("Liquidity renders the history note on its transaction-derived block",
    /TransactionCoverageNote[\s\S]*variant="history"/.test(lq));
}

console.log("SEMANTIC INERTNESS — no calculation was touched");
{
  // The copy resolver must be pure: no import of loaders / cash-flow folds / prisma.
  const mod = code("lib/transactions/coverage-note.ts");
  check("coverage-note imports nothing (pure string module)", !/\bimport\b/.test(mod));

  // The fold input is unchanged: Cash Flow still builds its projection from the SAME
  // args (transactions/accounts/period/moneyCtx/now) — transactionsMeta is NOT fed
  // into buildCashFlowSpaceData (that would be a semantic change).
  const cf = code("components/space/widgets/cashflow/CashFlowWorkspace.tsx");
  const buildCall = cf.slice(cf.indexOf("buildCashFlowSpaceData({"), cf.indexOf("buildCashFlowSpaceData({") + 160);
  check("buildCashFlowSpaceData is NOT passed transactionsMeta (fold untouched)",
    buildCall.length > 0 && !buildCall.includes("transactionsMeta"));
}

if (failures > 0) { console.error(`\ncoverage-note: ${failures} failure(s).`); process.exit(1); }
console.log("\ncoverage-note: all passed.");
