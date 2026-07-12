/**
 * components/connections/import/import-ui.test.ts
 *
 * A7-6 — source-scan contract tests for the import UI (repo style: no RTL). Asserts
 * the wiring the safety story depends on: the affordance is capability-gated and
 * appears on the ConnectionCard; the wizard binds the STABLE connection id, posts
 * to the safety-gated routes, disables Import on a blocking verdict, requires the
 * explicit confirmation for unproven files, rolls back via the canonical A7 route,
 * and shows only masked/server-provided labels. Also that unrelated ConnectionCard
 * actions are untouched.
 *
 *   npx tsx components/connections/import/import-ui.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
const card = read("components/connections/ConnectionCard.tsx");
const button = read("components/connections/import/ImportHistoryButton.tsx");
const wizard = read("components/connections/import/ImportHistoryWizard.tsx");

function main(): void {
  console.log("ConnectionCard renders the import affordance without disturbing other actions");
  check("card imports + renders ImportHistoryButton", /import { ImportHistoryButton }/.test(card) && /<ImportHistoryButton /.test(card));
  check("existing actions (Reconnect / EnableInvestments / SyncWallet) still present", /ReconnectAccountButton/.test(card) && /EnableInvestmentsButton/.test(card) && /SyncWalletButton/.test(card));

  console.log("affordance is capability-gated (Plaid + investment account + not importing)");
  check("gates on provider PLAID", /provider === "PLAID"/.test(button));
  check("gates on an investment/crypto account", /INVESTMENT_TYPES\.has\(a\.type\)/.test(button));
  check("hidden while first import is running", /state !== "importing"/.test(button));
  check("returns null when ineligible (never misleading)", /if \(!eligible\) return null/.test(button));

  console.log("wizard binds the STABLE connection id, never a display label");
  check("wizard is opened with connection.id", /connectionId=\{connection\.id\}/.test(button));
  check("accounts + history fetched by connection id", /\/api\/connections\/\$\{connectionId\}\/import-accounts/.test(wizard) && /\/api\/connections\/\$\{connectionId\}\/import-history/.test(wizard));

  console.log("wizard posts to the safety-gated A7 routes (preview → commit → rollback)");
  check("preview POST", /\/api\/accounts\/\$\{accountId\}\/import\/investments\/preview/.test(wizard));
  check("commit POST to the confirm route", /\/api\/accounts\/\$\{accountId\}\/import\/investments`/.test(wizard));
  check("rollback uses the canonical A7 rollback route", /\/api\/imports\/\$\{batchId\}\/rollback/.test(wizard));
  check("rollback goes through a ConfirmDialog (never a silent delete)", /<ConfirmDialog/.test(wizard) && /rollbackId/.test(wizard));

  console.log("commit is disabled on a blocking verdict + requires explicit confirmation");
  check("commit enabled only when canCommit and (not requiresConfirmation or confirmed)", /preview\?\.canCommit && \(!preview\?\.requiresConfirmation \|\| confirmed\)/.test(wizard));
  check("Import button disabled unless commitEnabled", /disabled=\{busy \|\| !commitEnabled\}/.test(wizard));
  check("explicit confirmation checkbox for unproven files", /requiresConfirmation &&/.test(wizard) && /type="checkbox"/.test(wizard));
  check("blocking reasons are surfaced", /blockingReasons\.length > 0/.test(wizard));
  check("commit sends the acknowledged flag only when confirmation is required", /requiresConfirmation\) fd\.append\("acknowledged"/.test(wizard));

  console.log("only masked / server-provided identifiers are rendered (no raw numbers)");
  check("wizard renders server 'label' fields, not raw masks/account numbers", /\.label/.test(wizard) && !/accountNumber/.test(wizard));
  check("import scoped to a single-file CSV input", /accept=".csv/.test(wizard));

  console.log("reuses canonical primitives (no new modal framework)");
  check("FormModal + GlassButton + ConfirmDialog reused", /@\/components\/atlas\/FormModal/.test(wizard) && /@\/components\/atlas\/GlassButton/.test(wizard) && /@\/components\/atlas\/ConfirmDialog/.test(wizard));

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nAll import-ui checks passed");
}

main();
