/**
 * lib/plaid/webhook-migration.test.ts  (Release 2 — domain split)
 *
 * The apply sequence against a FAKE Plaid — no live Item is touched:
 *   get (before) → idempotent skip → update → get (verify).
 * Pins: the target is server-derived and a stale dry-run target is refused;
 * dead Items are refused before any provider call; a provider that does not
 * hold the target after update is NOT_VERIFIED, never success; the access
 * token never appears in any result.
 */

import {
  applyItemWebhook,
  inspectItemWebhook,
  type WebhookMigrationDeps,
  type WebhookMigrationItem,
} from "@/lib/plaid/webhook-migration";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const APP = "https://app.fourthmeridian.com";
const TARGET = `${APP}/api/plaid/webhook`;
const APEX_HOOK = "https://fourthmeridian.com/api/plaid/webhook";
const TOKEN = "access-production-SECRET-TOKEN-VALUE";

function fake(opts: {
  item?: WebhookMigrationItem | null;
  webhook?: string | null;
  updateApplies?: boolean;
  failOn?: "get" | "update" | "verify";
  appUrl?: string;
}) {
  const calls: string[] = [];
  let stored = opts.webhook ?? null;
  let gets = 0;
  const plaidError = () => Object.assign(new Error(`boom ${TOKEN}`), { response: { data: { error_code: "ITEM_NOT_FOUND", error_message: `msg ${TOKEN}` } } });
  const deps: WebhookMigrationDeps = {
    loadItem: async () => (opts.item === undefined
      ? { id: "item_1", status: "ACTIVE", institutionName: "Bank", encryptedToken: "enc" }
      : opts.item),
    decrypt: () => TOKEN,
    appUrl: opts.appUrl ?? APP,
    lastAcknowledgedAt: async () => null,
    plaid: {
      itemGet: (async (req: { access_token: string }) => {
        calls.push(`get:${req.access_token === TOKEN}`);
        gets++;
        if (opts.failOn === "get" && gets === 1) throw plaidError();
        if (opts.failOn === "verify" && gets === 2) throw plaidError();
        return { data: { item: { webhook: stored } } };
      }) as never,
      itemWebhookUpdate: (async (req: { access_token: string; webhook?: string | null }) => {
        calls.push(`update:${req.webhook}`);
        if (opts.failOn === "update") throw plaidError();
        if (opts.updateApplies !== false) stored = req.webhook ?? null;
        return { data: {} };
      }) as never,
    },
  };
  return { deps, calls };
}

const noToken = (v: unknown) => !JSON.stringify(v).includes(TOKEN);

async function main(): Promise<void> {
  console.log("1. Dry run reads, never writes");
  {
    const { deps, calls } = fake({ webhook: APEX_HOOK });
    const r = await inspectItemWebhook("item_1", deps);
    check("ok", r.ok);
    check("plan UPDATE", r.ok && r.view.plan.action === "UPDATE");
    check("no update call", !calls.some((c) => c.startsWith("update")), calls.join());
    check("token never in result", noToken(r));
  }

  console.log("2. Apply: update then verify");
  {
    const { deps, calls } = fake({ webhook: APEX_HOOK });
    const r = await applyItemWebhook("item_1", TARGET, deps);
    check("UPDATED", r.ok && r.outcome === "UPDATED", JSON.stringify(r));
    check("before = apex, after = target", r.ok && r.before === APEX_HOOK && r.after === TARGET);
    check("sequence get → update(target) → get", calls.join() === `get:true,update:${TARGET},get:true`, calls.join());
    check("token never in result", noToken(r));
  }

  console.log("3. Idempotent: already current ⇒ no update call");
  {
    const { deps, calls } = fake({ webhook: TARGET });
    const r = await applyItemWebhook("item_1", TARGET, deps);
    check("ALREADY_CURRENT", r.ok && r.outcome === "ALREADY_CURRENT");
    check("only one get, no update", calls.join() === "get:true", calls.join());
  }

  console.log("4. Refusals before any provider call");
  {
    const stale = fake({ webhook: APEX_HOOK });
    const r1 = await applyItemWebhook("item_1", "https://evil.example/api/plaid/webhook", stale.deps);
    check("caller target ≠ server target ⇒ TARGET_MISMATCH", !r1.ok && r1.code === "TARGET_MISMATCH");
    check("…with no provider call", stale.calls.length === 0, stale.calls.join());

    const revoked = fake({ item: { id: "item_1", status: "REVOKED", institutionName: "Bank", encryptedToken: "enc" } });
    const r2 = await applyItemWebhook("item_1", TARGET, revoked.deps);
    check("REVOKED ⇒ SKIP_STATUS", !r2.ok && r2.code === "SKIP_STATUS");
    check("…with no provider call", revoked.calls.length === 0);

    const local = fake({ appUrl: "http://localhost:3000" });
    const r3 = await applyItemWebhook("item_1", TARGET, local.deps);
    check("no public app URL ⇒ NO_TARGET", !r3.ok && r3.code === "NO_TARGET");

    const missing = fake({ item: null });
    const r4 = await applyItemWebhook("nope", TARGET, missing.deps);
    check("unknown Item ⇒ NOT_FOUND", !r4.ok && r4.code === "NOT_FOUND");
  }

  console.log("5. Provider failures are codes, never messages or tokens");
  {
    for (const failOn of ["get", "update", "verify"] as const) {
      const { deps } = fake({ webhook: APEX_HOOK, failOn });
      const r = await applyItemWebhook("item_1", TARGET, deps);
      check(`${failOn} failure ⇒ PROVIDER_ERROR ITEM_NOT_FOUND`, !r.ok && r.code === "PROVIDER_ERROR" && r.providerError === "ITEM_NOT_FOUND", JSON.stringify(r));
      check(`${failOn} failure carries no token/message`, noToken(r) && !JSON.stringify(r).includes("msg"));
    }
  }

  console.log("6. A provider that does not hold the target is NOT success");
  {
    const { deps } = fake({ webhook: APEX_HOOK, updateApplies: false });
    const r = await applyItemWebhook("item_1", TARGET, deps);
    check("NOT_VERIFIED", !r.ok && r.code === "NOT_VERIFIED", JSON.stringify(r));
  }

  console.log(failures === 0
    ? "\n✅ webhook-migration: all checks passed"
    : `\n❌ webhook-migration: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
