/**
 * lib/plaid/duplicate-gate.test.ts  (BETA C4 — the widened duplicate-Item gate)
 *
 * A fresh Link session for an institution the customer ALREADY holds a live
 * (non-REVOKED) Item for must not mint a second billable Item. Before C4 the
 * gate was ACTIVE-only, so re-linking a NEEDS_REAUTH / ERROR bank created a
 * parallel Item while the first kept billing until someone revoked it.
 *
 *   npx tsx lib/plaid/duplicate-gate.test.ts
 *
 * The gate's selector and error are pure and pinned directly; the route's 409
 * contract and the rollback are pinned by source scan (the exchange itself
 * needs Plaid and a database).
 */

process.env.ENCRYPTION_KEY ??= "0".repeat(64);

import { readFileSync } from "node:fs";
import { DuplicateInstitutionError, duplicateGateWhere, duplicateInstitutionMessage } from "./exchangeToken";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const strip = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("\n1. the selector: any non-REVOKED Item of the same institution under a different item_id");
{
  const w = duplicateGateWhere("u1", "ins_3", "new-item");
  check("scoped to the user and institution", w.userId === "u1" && w.institutionId === "ins_3");
  check("blocks on status NOT REVOKED (ACTIVE, NEEDS_REAUTH and ERROR all block)", JSON.stringify(w.status) === '{"not":"REVOKED"}', JSON.stringify(w.status));
  check("an update-mode reconnect (same item_id) is never a duplicate", JSON.stringify(w.externalItemId) === '{"not":"new-item"}');
}

console.log("\n2. the error carries the re-link target, additively");
{
  const e = new DuplicateInstitutionError("Chase", "item_abc", "NEEDS_REAUTH");
  check("name and code", e.name === "DuplicateInstitutionError" && e.code === "DUPLICATE_INSTITUTION");
  check("existing Item id and status", e.existingItemId === "item_abc" && e.existingStatus === "NEEDS_REAUTH");
  check("a broken Item points the customer at Reconnect", /Reconnect/.test(e.message) && /Chase/.test(e.message));
  check("a healthy Item keeps the original 'refresh it' sentence",
    duplicateInstitutionMessage("Chase", "ACTIVE") === "You already have Chase connected — refresh it instead of reconnecting.");
  check("an ERROR Item also points at Reconnect", /Reconnect/.test(duplicateInstitutionMessage("Amex", "ERROR")));
}

console.log("\n3. [source] the gate, the rollback and the 409 contract");
{
  const x = strip("lib/plaid/exchangeToken.ts");
  check("the gate uses the pure selector", /where:\s*duplicateGateWhere\(userId, institution_id, item_id\)/.test(x));
  check("no ACTIVE-only duplicate lookup remains", !/institutionId: institution_id, status: PlaidItemStatus\.ACTIVE/.test(x));
  check("the just-minted Item is rolled back at Plaid (best-effort) before the throw",
    x.indexOf("await plaidClient.itemRemove({ access_token });") < x.indexOf("throw new DuplicateInstitutionError("));
  check("the throw names the existing Item and its status",
    /throw new DuplicateInstitutionError\(institution_name, duplicate\.id, String\(duplicate\.status\)\)/.test(x));
  check("the gate runs BEFORE the PlaidItem upsert", x.indexOf("duplicateGateWhere(") < x.indexOf("db.plaidItem.upsert("));
  const r = strip("app/api/plaid/exchange-token/route.ts");
  check("the route still answers 409 with `error`, plus code / existingItemId / existingStatus",
    /\{ error: err\.message, code: err\.code, existingItemId: err\.existingItemId, existingStatus: err\.existingStatus \},\s*\{ status: 409 \}/.test(r));
  check("the route's message no longer says 'active'", !/\bactive\b/i.test(r.slice(r.indexOf("DuplicateInstitutionError)"), r.indexOf("DuplicateInstitutionError)") + 400)));
}

console.log(failures === 0 ? "\n✅ duplicate gate: any live Item blocks a fresh link; the 409 names the re-link target.\n" : `\n❌ ${failures} failure(s)\n`);
process.exit(failures === 0 ? 0 : 1);
