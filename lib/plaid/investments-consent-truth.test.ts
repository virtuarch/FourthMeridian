/**
 * lib/plaid/investments-consent-truth.test.ts  (2026-10-06, Preview Plaid Sandbox lane)
 *
 * Consent is not support. First Platypus Bank - OAuth (Sandbox) carried
 * Investments in `consented_products` — we request it at Link — but its
 * institution offers no Investments product: investmentsHoldingsGet answered
 * PRODUCTS_NOT_SUPPORTED, the failure was logged as non-fatal, the stored
 * consent stayed ENABLED, every refresh repeated the failing call, and the
 * Connections card said "Investments synced".
 *
 *   npx tsx lib/plaid/investments-consent-truth.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Products, type Item } from "plaid";
import { PlaidInvestmentsConsent as C } from "@prisma/client";
import { deriveInvestmentsConsent, offersInvestments, reconcileInvestmentsConsent } from "./investmentsConsent";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const code = (f: string) => readFileSync(join(process.cwd(), f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const item = (over: Partial<Item>): Item => ({
  item_id: "item", institution_id: "ins_129644", webhook: null, error: null,
  available_products: [], billed_products: [Products.Transactions], products: [Products.Transactions],
  consented_products: [Products.Transactions, Products.Investments], consent_expiration_time: null,
  update_type: "background", ...over,
} as unknown as Item);

console.log("1. The endpoint's PRODUCTS_NOT_SUPPORTED outranks consent metadata");
{
  const consentedNotOffered = item({});
  check("consent alone derives ENABLED (why the card lied)", deriveInvestmentsConsent(consentedNotOffered) === C.ENABLED);
  check("…and Plaid's product lists do not offer Investments", !offersInvestments(consentedNotOffered));
  check("no stored answer yet ⇒ ENABLED (the holdings call is how support is learned)",
    reconcileInvestmentsConsent(null, consentedNotOffered) === C.ENABLED);
  check("REGRESSION: a stored UNSUPPORTED is NOT re-promoted by consent metadata (no flip-flop, no repeated failing call)",
    reconcileInvestmentsConsent(C.UNSUPPORTED, consentedNotOffered) === C.UNSUPPORTED);
  check("…but IS re-promoted when Plaid's product lists offer Investments",
    reconcileInvestmentsConsent(C.UNSUPPORTED, item({ billed_products: [Products.Transactions, Products.Investments] })) === C.ENABLED);
}

console.log("2. Unchanged derivation for every other case");
{
  check("not consented, offered ⇒ CONSENT_REQUIRED",
    reconcileInvestmentsConsent(null, item({ consented_products: [Products.Transactions], available_products: [Products.Investments] })) === C.CONSENT_REQUIRED);
  check("not consented, not offered ⇒ UNSUPPORTED",
    reconcileInvestmentsConsent(null, item({ consented_products: [Products.Transactions] })) === C.UNSUPPORTED);
  check("pre-DTM (no consent list) ⇒ null, caller keeps what is stored",
    reconcileInvestmentsConsent(C.ENABLED, item({ consented_products: [] })) === null);
  check("consented and offered ⇒ ENABLED",
    reconcileInvestmentsConsent(C.ENABLED, item({ products: [Products.Transactions, Products.Investments] })) === C.ENABLED);
}

console.log("3. The sync records the endpoint's answer and reconciles before acting");
{
  const src = code("lib/plaid/sync-investments.ts");
  check("PRODUCTS_NOT_SUPPORTED is persisted as UNSUPPORTED",
    /"PRODUCTS_NOT_SUPPORTED"\)\s*\{\s*await db\.plaidItem\.update\(\{[^}]*\},\s*data:\s*\{\s*investmentsConsent:\s*PlaidInvestmentsConsent\.UNSUPPORTED/.test(src));
  check("the stored state is reconciled (not blindly re-derived) before the holdings gate",
    /reconcileInvestmentsConsent\(storedConsent,\s*item\)/.test(src) && !/deriveInvestmentsConsent\(/.test(src));
  check("UNSUPPORTED is not holdings-callable", /holdingsCallable = consent === null \|\| consent === PlaidInvestmentsConsent\.ENABLED/.test(src));
}

if (failures > 0) { console.error(`\ninvestments-consent-truth.test: ${failures} failure(s).`); process.exit(1); }
console.log("\ninvestments-consent-truth.test: all passed.");
