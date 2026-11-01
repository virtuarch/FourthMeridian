/**
 * lib/platform/connections/operator-removal.test.ts  (PB-5)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/connections/operator-removal.test.ts
 *
 * The operator Remove connection, below the route (the route's gate is
 * app/api/platform/platform-ops/connections/[id]/remove/route.test.ts):
 *   1. the reason: fixed enum, optional capped note, scrubbed
 *   2. it USES disconnectAccounts — with the owner's live accounts on that one
 *      connection and the OWNER as the proved actor (injected spy + source pin)
 *   3. the operator-action audit: actor, reason, target, owner, outcome — built
 *      by the real envelope (buildOperatorActionData), success AND failure
 *   4. the notification: enqueued through createNotification (the registry
 *      chokepoint) with the registry type; never around it
 *   5. the gates hold for that type: FINANCIAL email off ⇒ no email; outside
 *      Production the recipient guard captures; the type is a registered,
 *      unlocked FINANCIAL type with the EMAIL leg on by default
 */

import { readFileSync } from "node:fs";
import { AuditAction } from "@/lib/audit-actions";
import { buildOperatorActionData, type OperatorActionInput } from "@/lib/audit";
import { createNotification, type NotificationWriteClient } from "@/lib/notifications/create";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import type { ChannelAdapter, ChannelMessage } from "@/lib/notifications/types";
import type { PreferenceClient, PreferenceOverride } from "@/lib/notifications/preferences";
import { decideRecipient } from "@/lib/email/recipient-guard";
import { parseRemovalRequest, removeConnectionAsOperator, REMOVAL_REASONS, type OperatorRemovalDeps } from "./operator-removal";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const OWNER = "user_owner_aaaaaa";
const ADMIN = "user_admin_000001";

/** A fake of the four fm_system reads the action performs. */
function fakeDb(opts: { item?: { id: string; userId: string; institutionName: string } | null; wallet?: { id: string; userId: string; externalConnectionId: string | null } | null; liveFa?: string[] }) {
  const seen: Record<string, unknown[]> = { accountConnection: [] };
  return {
    seen,
    db: {
      plaidItem: { findUnique: async () => opts.item ?? null },
      connection: { findFirst: async () => opts.wallet ?? null },
      accountConnection: {
        findMany: async (args: unknown) => { seen.accountConnection.push(args); return (opts.liveFa ?? []).map((financialAccountId) => ({ financialAccountId })); },
      },
    } as unknown as NonNullable<OperatorRemovalDeps["db"]>,
  };
}

function harness(over: { item?: Parameters<typeof fakeDb>[0]["item"]; wallet?: Parameters<typeof fakeDb>[0]["wallet"]; liveFa?: string[]; disconnectThrows?: boolean; markerConfirmed?: boolean | null } = {}) {
  const f = fakeDb({ item: over.item, wallet: over.wallet, liveFa: over.liveFa });
  const calls = { disconnect: [] as Array<[string[], string]>, audits: [] as ReturnType<typeof buildOperatorActionData>[], notify: [] as unknown[] };
  const deps: OperatorRemovalDeps = {
    db: f.db,
    disconnect: (async (ids: string[], actor: string) => {
      calls.disconnect.push([ids, actor]);
      if (over.disconnectThrows) throw new Error("phase 2 shortfall");
      return { disconnectedAccountIds: ids, affectedSpaceIds: ["s1"], plaidItemDbIds: over.item ? [over.item.id] : [] };
    }) as NonNullable<OperatorRemovalDeps["disconnect"]>,
    // The REAL envelope builder, so the row asserted is the row that would be written.
    record: (async (_c: unknown, input: OperatorActionInput) => { calls.audits.push(buildOperatorActionData(input)); return { id: `audit${calls.audits.length}` }; }) as NonNullable<OperatorRemovalDeps["record"]>,
    notify: (async (input: unknown) => { calls.notify.push(input); return { status: "created" as const, id: "n1" }; }) as NonNullable<OperatorRemovalDeps["notify"]>,
    readMarkers: async () => over.markerConfirmed === null || over.markerConfirmed === undefined ? [] : [{
      action: over.markerConfirmed ? AuditAction.PLAID_ITEM_REVOCATION_CONFIRMED : AuditAction.PLAID_ITEM_REVOCATION_UNCONFIRMED,
      createdAt: new Date(), metadata: { plaidItemId: "p1", ...(over.markerConfirmed ? { outcome: "REMOVED" } : {}) },
    }],
  };
  return { deps, calls, seen: f.seen };
}

const actor = { userId: ADMIN, via: "SYSTEM_ADMIN" as const, area: "PLATFORM_OPS" };
const req = { reason: "customer_request" as const, note: "Ticket asked us to remove it" };

async function main() {
  console.log("1. the reason");
  {
    check("the fixed enum is exactly the owner-approved five", REMOVAL_REASONS.join() === "customer_request,abuse,cost,account_closure,other");
    check("missing body / missing reason / unknown reason → error", ["error" in parseRemovalRequest(null), "error" in parseRemovalRequest({}), "error" in parseRemovalRequest({ reason: "fraud" })].every(Boolean));
    check("reason only → accepted, note null", JSON.stringify(parseRemovalRequest({ reason: "cost" })) === JSON.stringify({ request: { reason: "cost", note: null } }));
    check("note is trimmed", (parseRemovalRequest({ reason: "other", note: "  why  " }) as { request: { note: string } }).request.note === "why");
    check("note over 280 characters → error", "error" in parseRemovalRequest({ reason: "other", note: "x".repeat(281) }));
    check("note with an email / long digits / credential words → error",
      ["a@b.co", "acct 123456", "the password is"].every((n) => "error" in parseRemovalRequest({ reason: "other", note: n })));
    check("a non-string note → error", "error" in parseRemovalRequest({ reason: "other", note: 5 }));
  }

  console.log("2. the SAME disconnect primitive");
  {
    const h = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: ["fa1", "fa2", "fa1"], markerConfirmed: true });
    const r = await removeConnectionAsOperator({ connectionId: "p1", actor, request: req }, h.deps);
    check("removed", r.kind === "removed", r);
    check("disconnectAccounts called ONCE with the owner's live accounts (deduped) and the OWNER as actor",
      h.calls.disconnect.length === 1 && h.calls.disconnect[0][0].join() === "fa1,fa2" && h.calls.disconnect[0][1] === OWNER, h.calls.disconnect);
    const where = (h.seen.accountConnection[0] as { where: Record<string, unknown> }).where;
    check("the account read is THIS connection's live links on the owner's live accounts",
      where.deletedAt === null && where.plaidItemDbId === "p1" && JSON.stringify(where.financialAccount) === JSON.stringify({ deletedAt: null, ownerUserId: OWNER }), where);
    check("the outcome is RE-READ off the marker (CONFIRMED → Confirmed removed)", r.kind === "removed" && r.outcome === "CONFIRMED_REMOVED");

    const owed = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: ["fa1"], markerConfirmed: false });
    const r2 = await removeConnectionAsOperator({ connectionId: "p1", actor, request: req }, owed.deps);
    check("an UNCONFIRMED marker → Cleanup owed (the obligation lands where the cleanup widget reads it)", r2.kind === "removed" && r2.outcome === "CLEANUP_OWED");

    const w = harness({ wallet: { id: "w1", userId: OWNER, externalConnectionId: "bc1qexampleaddr123456" }, liveFa: ["fa9"] });
    const r3 = await removeConnectionAsOperator({ connectionId: "w1", actor, request: req }, w.deps);
    const wWhere = (w.seen.accountConnection[0] as { where: Record<string, unknown> }).where;
    check("a wallet: keyed by connectionId, outcome Not applicable, opaque label",
      r3.kind === "removed" && wWhere.connectionId === "w1" && r3.outcome === "NOT_APPLICABLE" && r3.institution === "Self-custody wallet …123456", r3);

    const none = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: [] });
    const r4 = await removeConnectionAsOperator({ connectionId: "p1", actor, request: req }, none.deps);
    check("nothing live → nothing_live; nothing disconnected, audited or sent",
      r4.kind === "nothing_live" && none.calls.disconnect.length === 0 && none.calls.audits.length === 0 && none.calls.notify.length === 0);

    const missing = harness({});
    check("unknown id → not_found", (await removeConnectionAsOperator({ connectionId: "nope", actor, request: req }, missing.deps)).kind === "not_found");

    const src = code("lib/platform/connections/operator-removal.ts");
    check("source pin: imports disconnectAccounts from the ONE primitive and calls it", /from "@\/lib\/accounts\/disconnect"/.test(src) && /await disconnect\(faIds, ownerUserId\)/.test(src) && /deps\.disconnect \?\? disconnectAccounts/.test(src));
    check("source pin: no second engine — no Plaid call, no status / token write, no soft-delete of its own",
      !/itemRemove|plaidClient|disconnectPlaidItemIfOrphaned|setPlaidItemHealth|encryptedToken|updateMany|deletedAt:\s*new Date|status:\s*PlaidItemStatus/.test(src));
    const route = code("app/api/platform/platform-ops/connections/[id]/remove/route.ts");
    check("route delegates to removeConnectionAsOperator (no logic of its own)", /removeConnectionAsOperator\(/.test(route) && !/disconnectAccounts|itemRemove|auditLog\./.test(route));
  }

  console.log("3. the operator-action audit");
  {
    const h = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: ["fa1", "fa2"], markerConfirmed: true });
    await removeConnectionAsOperator({ connectionId: "p1", actor, request: req, ipAddress: "203.0.113.9", userAgent: "UA" }, h.deps);
    const a = h.calls.audits[0];
    type Meta = Record<string, unknown> & { actor: { via: string; area: string }; target: { kind: string; id: string }; reason: { code: string; note?: string } };
    const m = a.metadata as unknown as Meta;
    check("ONE row, action CONNECTION_REMOVED_BY_OPERATOR, performedByAdminId = the operator", h.calls.audits.length === 1 && a.action === AuditAction.CONNECTION_REMOVED_BY_OPERATOR && a.performedByAdminId === ADMIN);
    check("actor: SYSTEM_ADMIN via the role, PLATFORM_OPS area", m.actorType === "SYSTEM_ADMIN" && m.actor.via === "SYSTEM_ADMIN" && m.actor.area === "PLATFORM_OPS");
    check("target: the PLAID_ITEM", m.target.kind === "PLAID_ITEM" && m.target.id === "p1");
    check("reason: envelope code + scrubbed note, and the exact PB-5 reason in detail",
      m.reason.code === "SUPPORT_REQUEST" && m.reason.note === req.note && m.removalReason === "customer_request", m);
    check("owner + outcome + counts recorded", m.ownerUserId === OWNER && m.outcome === "CONFIRMED_REMOVED" && m.accountCount === 2 && m.institution === "Chase" && m.result === "SUCCESS");
    check("no userId subject on the row (a connection action has no USER target)", a.userId === undefined);
    check("ip / user agent carried", a.ipAddress === "203.0.113.9" && a.userAgent === "UA");
    check("the action is reason-REQUIRED in the envelope", (() => { try { buildOperatorActionData({ actor, action: AuditAction.CONNECTION_REMOVED_BY_OPERATOR, target: { kind: "PLAID_ITEM", id: "p1" }, result: "SUCCESS" }); return false; } catch { return true; } })());

    const f = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: ["fa1"], disconnectThrows: true });
    const origError = console.error; console.error = () => {};
    const rf = await removeConnectionAsOperator({ connectionId: "p1", actor, request: req }, f.deps);
    console.error = origError;
    const fm = f.calls.audits[0]?.metadata as Record<string, unknown> | undefined;
    check("a failed disconnect is recorded as FAILURE, and the customer is NOT told",
      rf.kind === "failed" && fm?.result === "FAILURE" && fm?.outcome === "DISCONNECT_FAILED" && f.calls.notify.length === 0, { rf, fm });
  }

  console.log("4. the notification goes through the registry chokepoint");
  {
    const h = harness({ item: { id: "p1", userId: OWNER, institutionName: "Chase" }, liveFa: ["fa1"], markerConfirmed: true });
    const r = await removeConnectionAsOperator({ connectionId: "p1", actor, request: req }, h.deps);
    const n = h.calls.notify[0] as { type: string; userId: string; data: Record<string, unknown>; auditLogId: string };
    check("enqueued once, to the OWNER, as CONNECTION_REMOVED_BY_SUPPORT, anchored to the audit row",
      h.calls.notify.length === 1 && n.type === "CONNECTION_REMOVED_BY_SUPPORT" && n.userId === OWNER && n.auditLogId === "audit1", n);
    check("payload = the registry pointerContract exactly (no operator, no reason note)",
      Object.keys(n.data).sort().join() === [...NOTIFICATION_REGISTRY.CONNECTION_REMOVED_BY_SUPPORT.pointerContract].sort().join()
        && !JSON.stringify(n.data).includes(req.note) && !JSON.stringify(n.data).includes(ADMIN));
    check("the result reports the chokepoint's own status", r.kind === "removed" && r.notification === "created");

    const src = code("lib/platform/connections/operator-removal.ts");
    check("source pin: createNotification is the default notifier", /deps\.notify \?\? createNotification/.test(src) && /from "@\/lib\/notifications\/create"/.test(src));
    check("source pin: never sends around the chokepoint (no sendEmail / channel adapter / provider / inAppOnly)",
      !/sendEmail|emailNotificationAdapter|lib\/email\/|resend|inAppOnly|notification\.create/.test(src));
    check("the audit row is written BEFORE the notification", src.indexOf("CONNECTION_REMOVED_BY_OPERATOR, target, reason, result: \"SUCCESS\"") < src.indexOf("type: \"CONNECTION_REMOVED_BY_SUPPORT\""));
  }

  console.log("5. the existing gates apply to this type");
  {
    const def = NOTIFICATION_REGISTRY.CONNECTION_REMOVED_BY_SUPPORT;
    check("a registered, WIRED, FINANCIAL type; EMAIL on by default; NOT locked (preferences apply)",
      def.status === "WIRED" && def.category === "FINANCIAL" && (def.defaultChannels as readonly string[]).includes("EMAIL") && def.locked === false);
    check("copy says support removed it, names the institution, links to Connections",
      (() => { const r = def.render({ institutionName: "Chase" }); return r.title === "A connection was removed by support" && /Chase/.test(r.body ?? "") && r.href === "/dashboard/connections"; })());

    // The REAL chokepoint over an in-memory client (the create.test.ts pattern).
    const run = async (prefs: PreferenceOverride[]) => {
      const rows: unknown[] = [];
      const deliveries: unknown[] = [];
      const client = {
        user: { findUnique: async () => ({ email: "owner@example.com" }) },
        notificationDelivery: { create: async ({ data }: { data: unknown }) => { deliveries.push(data); return { id: "d1" }; } },
        notification: {
          create: async ({ data }: { data: unknown }) => { rows.push(data); return { id: `n${rows.length}` }; },
          findUnique: async () => null,
          update: async () => ({ id: "n1" }),
        },
      } as unknown as NotificationWriteClient;
      const prefClient: PreferenceClient = { notificationPreference: { findMany: async () => prefs, upsert: async () => { throw new Error("unused"); } } } as unknown as PreferenceClient;
      const messages: ChannelMessage[] = [];
      const emailAdapter: ChannelAdapter = { channel: "EMAIL", name: "fake", async deliver(m) { messages.push(m); return { status: "captured", provider: "none" }; } };
      const res = await createNotification(
        { type: "CONNECTION_REMOVED_BY_SUPPORT", userId: OWNER, data: { connectionId: "p1", institutionName: "Chase", provider: "PLAID" } },
        { client, prefClient, emailAdapter, ledger: async () => {}, content: null },
      );
      return { res, rows, messages };
    };
    const on = await run([]);
    check("defaults: the in-app row is written AND the EMAIL leg reaches the channel adapter (→ sendEmail)",
      on.res.status === "created" && on.rows.length === 1 && on.messages.length === 1 && on.messages[0].type === "CONNECTION_REMOVED_BY_SUPPORT", on.res);
    const off = await run([{ category: "FINANCIAL", channel: "EMAIL", enabled: false }]);
    check("FINANCIAL email OFF: in-app row only, the adapter is never called (the preference gate holds)",
      off.res.status === "created" && off.messages.length === 0);
    check("outside Production the recipient guard CAPTURES (empty allowlist = capture everything)",
      decideRecipient("owner@example.com", { VERCEL: "1", VERCEL_ENV: "preview" }).deliver === false
        && decideRecipient("owner@example.com", {}).deliver === false);
  }

  console.log(failures === 0 ? "\n✅ operator removal: one engine, audited with a reason, the customer told through the gated chokepoint." : `\n❌ ${failures} failure(s)`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
