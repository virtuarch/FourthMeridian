/**
 * lib/plaid/webhook-migration.core.test.ts  (Release 2 — domain split)
 *
 * Pins the pure rules of the Plaid webhook migration: the target is derived
 * only from a public HTTPS app base, the plan refuses dead Items, is idempotent
 * on an exact match, and redaction never emits a query string.
 */

import {
  expectedWebhookUrl,
  planWebhookMigration,
  redactWebhookUrl,
  PLAID_WEBHOOK_PATH,
} from "@/lib/plaid/webhook-migration.core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const APP  = "https://app.fourthmeridian.com";
const APEX = "https://fourthmeridian.com";
const TARGET = `${APP}${PLAID_WEBHOOK_PATH}`;

console.log("1. Target derives only from a public HTTPS base");
{
  check("app origin", expectedWebhookUrl(APP) === TARGET, String(expectedWebhookUrl(APP)));
  check("trailing slash tolerated", expectedWebhookUrl(`${APP}/`) === TARGET);
  check("whitespace tolerated", expectedWebhookUrl(`  ${APP}  `) === TARGET);
  check("undefined ⇒ null", expectedWebhookUrl(undefined) === null);
  check("empty ⇒ null", expectedWebhookUrl("") === null);
  check("http ⇒ null", expectedWebhookUrl("http://app.fourthmeridian.com") === null);
  check("localhost ⇒ null", expectedWebhookUrl("https://localhost:3000") === null);
  check("loopback ⇒ null", expectedWebhookUrl("https://127.0.0.1") === null);
  check("malformed ⇒ null", expectedWebhookUrl("not a url") === null);
  check("credentials in base ⇒ null", expectedWebhookUrl("https://u:p@app.fourthmeridian.com") === null);
  check("query in base ⇒ null", expectedWebhookUrl(`${APP}?x=1`) === null);
}

console.log("2. Plan per Item");
{
  const up = planWebhookMigration({ status: "ACTIVE", currentWebhook: `${APEX}${PLAID_WEBHOOK_PATH}`, target: TARGET });
  check("apex webhook on ACTIVE ⇒ UPDATE", up.action === "UPDATE", up.action);
  check("plan reports redacted current", up.current === `${APEX}${PLAID_WEBHOOK_PATH}`, String(up.current));

  const same = planWebhookMigration({ status: "ACTIVE", currentWebhook: TARGET, target: TARGET });
  check("exact match ⇒ ALREADY_CURRENT (idempotent)", same.action === "ALREADY_CURRENT", same.action);

  const reauth = planWebhookMigration({ status: "NEEDS_REAUTH", currentWebhook: `${APEX}${PLAID_WEBHOOK_PATH}`, target: TARGET });
  check("NEEDS_REAUTH still has a token ⇒ UPDATE", reauth.action === "UPDATE", reauth.action);

  const revoked = planWebhookMigration({ status: "REVOKED", currentWebhook: `${APEX}${PLAID_WEBHOOK_PATH}`, target: TARGET });
  check("REVOKED ⇒ SKIP_STATUS", revoked.action === "SKIP_STATUS", revoked.action);

  const none = planWebhookMigration({ status: "ACTIVE", currentWebhook: null, target: TARGET });
  check("no webhook registered ⇒ UPDATE", none.action === "UPDATE", none.action);

  const noTarget = planWebhookMigration({ status: "ACTIVE", currentWebhook: `${APEX}${PLAID_WEBHOOK_PATH}`, target: null });
  check("no target ⇒ NO_TARGET (refuse)", noTarget.action === "NO_TARGET", noTarget.action);

  const near = planWebhookMigration({ status: "ACTIVE", currentWebhook: `${TARGET}/`, target: TARGET });
  check("near-miss (trailing slash) is not treated as current", near.action === "UPDATE", near.action);
}

console.log("3. Redaction");
{
  check("drops query", redactWebhookUrl(`${APP}/hook?token=abc`) === `${APP}/hook`, String(redactWebhookUrl(`${APP}/hook?token=abc`)));
  check("drops fragment", redactWebhookUrl(`${APP}/hook#x`) === `${APP}/hook`);
  check("null ⇒ null", redactWebhookUrl(null) === null);
  check("unparseable ⇒ <invalid>", redactWebhookUrl("::::") === "<invalid>");
}

console.log(failures === 0
  ? "\n✅ webhook-migration.core: all checks passed"
  : `\n❌ webhook-migration.core: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
