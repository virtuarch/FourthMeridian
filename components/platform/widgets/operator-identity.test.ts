/**
 * components/platform/widgets/operator-identity.test.ts  (P1 — owner rulings 2026-10-08)
 *
 * Two presentation rulings, pinned at the source:
 *   1. USERNAME FIRST on operator list surfaces (Customer Success customers,
 *      Growth users): the primary identifier is operatorDisplayName(), never the
 *      raw email; email stays in the customer DETAIL view. Beta requests are
 *      pre-user and keep the address (an invitation IS an address).
 *   2. A consequential operator action answers where it was pressed: the Customer
 *      Success "Refresh all" renders the SAME one-sentence description the
 *      customer's Refresh button uses (lib/refresh/outcomes.ts
 *      describeRefreshOutcomes) in the footer beside the button — not only a
 *      section at the bottom of the detail body.
 * Run: npx tsx components/platform/widgets/operator-identity.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) =>
  readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

console.log("username first on operator lists");
{
  const cs = strip("components/platform/widgets/CsCustomersWidget.tsx");
  const users = strip("components/platform/widgets/OpsUsersWidget.tsx");
  check("Customer Success list row renders operatorDisplayName, not the email", /operatorDisplayName\(c\)/.test(cs) && !/\{c\.email\}/.test(cs));
  check("Customer Success detail shows Username AND Email rows", /label="Username"/.test(cs) && /label="Email" value=\{detail\.identity\.email\}/.test(cs));
  check("Growth users row renders operatorDisplayName, not the email", /operatorDisplayName\(u\)/.test(users) && !/\{u\.email\}/.test(users));
  check("search still matches email (the capability is kept)", /email/.test(strip("lib/platform/customer/customers.ts")) && /email: \{ contains: search/.test(strip("app/api/platform/growth-revenue/users/route.ts")));
  check("client widgets import the pure identity-label module, never customer-core (server-only chain)",
    /from "@\/lib\/platform\/customer\/identity-label"/.test(cs) && /from "@\/lib\/platform\/customer\/identity-label"/.test(users)
    && !/platform\/customer\/customer-core"/.test(cs) && !/platform\/customer\/customer-core"/.test(users));
  check("beta requests keep the address (pre-user)", /\.email/.test(strip("components/platform/widgets/GrowthBetaRequestsWidget.tsx")));
}

console.log("a consequential action answers where it was pressed");
{
  const cs = strip("components/platform/widgets/CsCustomersWidget.tsx");
  const footer = cs.slice(cs.indexOf("<PanelFooter>"), cs.indexOf("</PanelFooter>"));
  check("the footer renders describeRefreshOutcomes over the operator report", /describeRefreshOutcomes\(refreshReport\.outcomes\)/.test(footer));
  check("…as a status element while not acting", /role="status"/.test(footer));
  check("…and an in-progress line while acting", /acting === "refresh" && /.test(footer));
  check("the describer is the SHARED one from the outcome vocabulary", /from "@\/lib\/refresh\/outcomes"/.test(cs) && /export function describeRefreshOutcomes/.test(strip("lib/refresh/outcomes.ts")));
  check("the customer hook imports the same describer (no second semantics)", /from "@\/lib\/refresh\/outcomes"/.test(strip("components/plaid/useManualRefresh.ts")) && !/export function describeRefreshOutcomes/.test(strip("components/plaid/useManualRefresh.ts")));
  check("the reason is kept between consecutive actions (not cleared on success)", !/setReasonCode\(""\); setReasonNote\(""\)/.test(cs));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
