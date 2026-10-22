/**
 * lib/plaid/webhook-receiver.test.ts  (OPERATIONALIZATION P0 — Workstream B)
 *
 * The receiver's decision, branch by branch, DB-free and Plaid-free:
 *   · a REVOKED / NEEDS_REAUTH / ERROR Item or an inactive owner NEVER starts
 *     the pipeline — the defect this slice closes (the route used to resolve the
 *     Item by id with no status filter and nothing downstream read status);
 *   · every VERIFIED webhook leaves exactly one evidence row with the allowlisted
 *     fields; a rejected signature leaves none;
 *   · Plaid's ack semantics are preserved (401 / 400 / 200 handled:true|false).
 * Plus a source scan of the writer and the route.
 *
 * Run:  npx tsx lib/plaid/webhook-receiver.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decidePlaidWebhook, handlePlaidWebhook, isSyncTrigger, webhookErrorCode, webhookHealthTransition,
  type WebhookItemRef, type WebhookReceiverDeps,
} from "./webhook-receiver";
import type { PlaidWebhookEventInput } from "./webhook-event";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const ITEM = (status: string, ownerDeactivated = false): WebhookItemRef => ({ id: "pi_1", status, ownerDeactivated });
const quiet = { log: () => {}, warn: () => {} };

function harness(item: WebhookItemRef | null, verifyOk = true, seen: Set<string> = new Set()) {
  const health: Array<{ id: string; status: string; errorCode: string }> = [];
  const events: PlaidWebhookEventInput[] = [];
  const scheduled: string[] = [];
  const lookups: string[] = [];
  const deps: WebhookReceiverDeps = {
    verify: async () => (verifyOk ? { ok: true } : { ok: false, reason: "bad-signature" }),
    lookupItem: async (id) => { lookups.push(id); return item; },
    recordEvent: (e) => { events.push(e); },
    scheduleSync: (id) => { scheduled.push(id); },
    environment: () => "test-env",
    log: quiet,
    // IDEMP-006 — an in-memory dedupe store with the real store's semantics.
    isDuplicate: async (sha) => { if (seen.has(sha)) return true; seen.add(sha); return false; },
    applyHealth: async (id, t) => { health.push({ id, ...t }); },
  };
  return { deps, events, scheduled, lookups, health };
}
const body = (o: Record<string, unknown>) => JSON.stringify(o);
const TX = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "ext_1" };

async function main() {
  console.log("decision · eligibility (pure)");
  {
    check("ACTIVE + live owner ⇒ SYNC_SCHEDULED", decidePlaidWebhook("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", ITEM("ACTIVE")).handling === "SYNC_SCHEDULED");
    for (const s of ["REVOKED", "NEEDS_REAUTH", "ERROR"]) {
      const d = decidePlaidWebhook("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE", ITEM(s));
      check(`${s} ⇒ REFUSED_ITEM_STATUS and no schedule`, d.handling === "REFUSED_ITEM_STATUS" && !d.schedule && !d.handled);
    }
    const dead = decidePlaidWebhook("HOLDINGS", "DEFAULT_UPDATE", ITEM("ACTIVE", true));
    check("deactivated owner ⇒ REFUSED_OWNER_INACTIVE", dead.handling === "REFUSED_OWNER_INACTIVE" && !dead.schedule);
    check("status is checked before owner (REVOKED + dead owner reads as the Item's state)",
      decidePlaidWebhook("TRANSACTIONS", "DEFAULT_UPDATE", ITEM("REVOKED", true)).handling === "REFUSED_ITEM_STATUS");
    check("unknown Item ⇒ UNKNOWN_ITEM", decidePlaidWebhook("TRANSACTIONS", "INITIAL_UPDATE", null).handling === "UNKNOWN_ITEM");
    check("non-trigger ⇒ ACKNOWLEDGED even for an ACTIVE Item", decidePlaidWebhook("ITEM", "ERROR", ITEM("ACTIVE")).handling === "ACKNOWLEDGED");
    check("non-trigger with no Item ⇒ ACKNOWLEDGED, not UNKNOWN_ITEM", decidePlaidWebhook("ITEM", "PENDING_EXPIRATION", null).handling === "ACKNOWLEDGED");
    check("HOLDINGS/DEFAULT_UPDATE is a trigger; HOLDINGS/other is not", isSyncTrigger("HOLDINGS", "DEFAULT_UPDATE") && !isSyncTrigger("HOLDINGS", "X"));
    check("TRANSACTIONS legacy codes trigger", ["HISTORICAL_UPDATE", "INITIAL_UPDATE", "DEFAULT_UPDATE"].every((c) => isSyncTrigger("TRANSACTIONS", c)));
    check("TRANSACTIONS_REMOVED is not a trigger", !isSyncTrigger("TRANSACTIONS", "TRANSACTIONS_REMOVED"));
    check("error code: Plaid's error.error_code only", webhookErrorCode({ error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "secret-ish" } }) === "ITEM_LOGIN_REQUIRED");
    check("error code: null when absent/null/non-object", webhookErrorCode({ error: null }) === null && webhookErrorCode({}) === null && webhookErrorCode({ error: "x" }) === null);
  }

  console.log("\nreceiver · the defect — a REVOKED Item never reaches the provider");
  {
    const h = harness(ITEM("REVOKED"));
    const r = await handlePlaidWebhook(body(TX), "sig", h.deps);
    check("200 so Plaid does not retry", r.status === 200);
    check("handled:false", r.body.handled === false && r.body.received === true);
    check("NO sync scheduled", h.scheduled.length === 0, JSON.stringify(h.scheduled));
    check("one evidence row, REFUSED_ITEM_STATUS, status REVOKED recorded",
      h.events.length === 1 && h.events[0].handling === "REFUSED_ITEM_STATUS" && h.events[0].itemStatusAtReceipt === "REVOKED" && h.events[0].plaidItemId === "pi_1");
  }
  {
    const h = harness(ITEM("ACTIVE", true));
    const r = await handlePlaidWebhook(body(TX), "sig", h.deps);
    check("deactivated owner: 200 handled:false, no sync, REFUSED_OWNER_INACTIVE with ownerInactive:true",
      r.status === 200 && r.body.handled === false && h.scheduled.length === 0
        && h.events[0]?.handling === "REFUSED_OWNER_INACTIVE" && h.events[0]?.ownerInactive === true);
  }

  console.log("\nreceiver · the happy path is unchanged");
  {
    const h = harness(ITEM("ACTIVE"));
    const r = await handlePlaidWebhook(body(TX), "sig", h.deps);
    check("ACTIVE: 200 handled:true and the pipeline is scheduled for OUR item id", r.status === 200 && r.body.handled === true && h.scheduled.join() === "pi_1");
    const e = h.events[0];
    check("evidence: SYNC_SCHEDULED with identity, type/code, status, owner, environment",
      e.handling === "SYNC_SCHEDULED" && e.externalItemId === "ext_1" && e.plaidItemId === "pi_1" && e.webhookType === "TRANSACTIONS"
        && e.webhookCode === "SYNC_UPDATES_AVAILABLE" && e.itemStatusAtReceipt === "ACTIVE" && e.ownerInactive === false && e.environment === "test-env" && e.errorCode === null);
    check("lookup by the delivered item_id", h.lookups.join() === "ext_1");
  }

  console.log("\nreceiver · non-trigger webhooks are acknowledged AND recorded");
  {
    const h = harness(ITEM("ACTIVE"));
    const r = await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext_1",
      error: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "the user's credentials…", display_message: null } }), "sig", h.deps);
    check("ITEM/ERROR: 200, no sync", r.status === 200 && h.scheduled.length === 0);
    // FIN-007 — ITEM_LOGIN_REQUIRED now moves the Item to NEEDS_REAUTH (it was a no-op).
    check("ITEM/ERROR ITEM_LOGIN_REQUIRED: HEALTH_TRANSITION row with Plaid error CODE, resolved Item and its status",
      h.events[0]?.handling === "HEALTH_TRANSITION" && h.events[0]?.errorCode === "ITEM_LOGIN_REQUIRED" && h.events[0]?.plaidItemId === "pi_1" && h.events[0]?.itemStatusAtReceipt === "ACTIVE");
    check("FIN-007: NEEDS_REAUTH applied through the health chokepoint", h.health.length === 1 && h.health[0].status === "NEEDS_REAUTH" && h.health[0].errorCode === "ITEM_LOGIN_REQUIRED");
    check("no message text in the recorded fact", !JSON.stringify(h.events).includes("credentials"));
  }
  {
    const h = harness(ITEM("REVOKED"));
    await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext_1" }), "sig", h.deps);
    check("USER_PERMISSION_REVOKED on a REVOKED Item: recorded with the status we held, no transition", h.events[0]?.handling === "ACKNOWLEDGED" && h.events[0]?.itemStatusAtReceipt === "REVOKED" && h.health.length === 0);
  }

  console.log("\nFIN-007 · ITEM webhooks map to the existing health transitions");
  {
    const h = harness(ITEM("ACTIVE"));
    await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext_1" }), "sig", h.deps);
    check("USER_PERMISSION_REVOKED on an ACTIVE Item ⇒ REVOKED", h.health[0]?.status === "REVOKED" && h.events[0]?.handling === "HEALTH_TRANSITION");
    const h2 = harness(ITEM("ACTIVE"));
    await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "ext_1", error: { error_code: "INSTITUTION_DOWN" } }), "sig", h2.deps);
    check("ITEM/ERROR with a non-reauth (possibly transient) code is NOT mapped", h2.health.length === 0 && h2.events[0]?.handling === "ACKNOWLEDGED");
    const h3 = harness(ITEM("ACTIVE"));
    await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "PENDING_EXPIRATION", item_id: "ext_1" }), "sig", h3.deps);
    check("PENDING_EXPIRATION is recorded, not mapped (the Item still syncs until the date)", h3.health.length === 0 && h3.events[0]?.handling === "ACKNOWLEDGED");
    check("pure mapping table", webhookHealthTransition("ITEM", "ERROR", "INVALID_ACCESS_TOKEN")?.status === "NEEDS_REAUTH"
      && webhookHealthTransition("ITEM", "USER_ACCOUNT_REVOKED", null)?.status === "REVOKED"
      && webhookHealthTransition("TRANSACTIONS", "ERROR", "ITEM_LOGIN_REQUIRED") === null);
    const h4 = harness(ITEM("ACTIVE"));
    h4.deps.applyHealth = async () => { throw new Error("db down"); };
    const r4 = await handlePlaidWebhook(body({ webhook_type: "ITEM", webhook_code: "USER_PERMISSION_REVOKED", item_id: "ext_1" }), "sig", h4.deps);
    check("a failing health write never turns into a non-200", r4.status === 200 && h4.events[0]?.handling === "ACKNOWLEDGED");
  }

  console.log("\nIDEMP-006 · duplicate verified deliveries start one pipeline");
  {
    const seen = new Set<string>();
    const a = harness(ITEM("ACTIVE"), true, seen);
    await handlePlaidWebhook(body(TX), "sig", a.deps);
    const b = harness(ITEM("ACTIVE"), true, seen);
    const rb = await handlePlaidWebhook(body(TX), "sig", b.deps);
    check("first delivery schedules the pipeline", a.scheduled.length === 1 && a.events[0]?.handling === "SYNC_SCHEDULED");
    check("the identical body again ⇒ DUPLICATE_SUPPRESSED, no second pipeline, still 200 and recorded",
      b.scheduled.length === 0 && rb.status === 200 && rb.body.handled === false && b.events[0]?.handling === "DUPLICATE_SUPPRESSED");
    const c = harness(ITEM("ACTIVE"), true, seen);
    await handlePlaidWebhook(body({ ...TX, webhook_code: "HISTORICAL_UPDATE" }), "sig", c.deps);
    check("a different body for the same Item is not a duplicate", c.scheduled.length === 1);
    const d = harness(ITEM("REVOKED"), true, new Set());
    let asked = false; d.deps.isDuplicate = async () => { asked = true; return false; };
    await handlePlaidWebhook(body(TX), "sig", d.deps);
    check("dedupe is consulted only for a delivery that would schedule (no store write for refusals)", !asked);
  }
  {
    const h = harness(null);
    const r = await handlePlaidWebhook(body(TX), "sig", h.deps);
    check("unknown Item: 200 handled:false, UNKNOWN_ITEM row with null status/owner",
      r.status === 200 && r.body.handled === false && h.events[0]?.handling === "UNKNOWN_ITEM" && h.events[0]?.itemStatusAtReceipt === null && h.events[0]?.ownerInactive === null);
  }
  {
    const h = harness(null);
    const r = await handlePlaidWebhook(body({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE" }), "sig", h.deps);
    check("trigger without item_id: acknowledged, not looked up, recorded with null identity",
      r.status === 200 && h.lookups.length === 0 && h.events.length === 1 && h.events[0].externalItemId === null && h.events[0].handling === "UNKNOWN_ITEM");
  }
  {
    const h = harness(ITEM("ACTIVE"));
    await handlePlaidWebhook(body({ webhook_type: "x".repeat(500), webhook_code: 42, item_id: "ext_1" }), "sig", h.deps);
    check("oversized/non-string fields are clipped or UNKNOWN", h.events[0]?.webhookType.length === 64 && h.events[0]?.webhookCode === "UNKNOWN");
  }

  console.log("\nreceiver · signature and shape gates");
  {
    const h = harness(ITEM("ACTIVE"), false);
    const r = await handlePlaidWebhook(body(TX), "sig", h.deps);
    check("bad signature: 401, no lookup, no row, no sync", r.status === 401 && h.lookups.length === 0 && h.events.length === 0 && h.scheduled.length === 0 && r.event === null);
  }
  {
    const h = harness(ITEM("ACTIVE"));
    const r = await handlePlaidWebhook("{not json", "sig", h.deps);
    check("malformed JSON: 400, no row, no sync", r.status === 400 && h.events.length === 0 && h.scheduled.length === 0);
  }
  {
    const h = harness(ITEM("ACTIVE"));
    const r = await handlePlaidWebhook("[1,2]", "sig", h.deps);
    check("non-object JSON: acknowledged with UNKNOWN type/code, nothing scheduled", r.status === 200 && h.events[0]?.webhookType === "UNKNOWN" && h.scheduled.length === 0);
  }

  console.log("\nsource · writer and route");
  {
    const root = process.cwd();
    const strip = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const writer = strip("lib/plaid/webhook-event.ts");
    const ALLOW = ["externalItemId", "plaidItemId", "webhookType", "webhookCode", "errorCode", "itemStatusAtReceipt", "ownerInactive", "handling", "environment"];
    const dataBlock = /data:\s*\{([\s\S]*?)\},\s*\}\)/.exec(writer)?.[1] ?? "";
    const keys = [...dataBlock.matchAll(/^\s*([A-Za-z]+):/gm)].map((m) => m[1]);
    check("writer persists exactly the allowlisted fields", keys.length === ALLOW.length && ALLOW.every((k) => keys.includes(k)), keys.join());
    check("writer never touches token, payload, account or user identity", !/encryptedToken|rawBody|payload|accountId|userId|email/.test(writer));
    check("writer defaults to systemDb (fm_system), never the migration principal", /= systemDb/.test(writer) && !/\?\?\s*db\b|=\s*db\b/.test(writer));
    check("writer is non-throwing", /try\s*\{[\s\S]*catch/.test(writer));
    const route = strip("app/api/plaid/webhook/route.ts");
    check("route selects the Item's status and owner deactivation", /status:\s*true/.test(route) && /deactivatedAt:\s*true/.test(route));
    check("route delegates the decision to the receiver", /handlePlaidWebhook\(/.test(route));
    check("route still defers the pipeline via after()", /after\(\(\)\s*=>\s*syncPlaidItemFromWebhook\(/.test(route));
    check("route never calls runDeferredHistorySync directly", !/runDeferredHistorySync\(/.test(route));
    check("route keeps maxDuration 300", /export const maxDuration = 300/.test(route));
    check("receiver imports no database module", !/@\/lib\/db/.test(strip("lib/plaid/webhook-receiver.ts")));
  }

  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
}
main();
