/**
 * lib/platform/activity/operator-feed.test.ts  (UX-P1 · D6)
 *
 * THE PLATFORM OPERATIONS ACTIVITY FEED IS NARROW BY CONSTRUCTION. Proves the
 * allowlist (platform objects in, security events out), the opaque-target rule
 * (a customer is never named here, even on Refresh All), and that no email, note,
 * IP or user-agent survives projection. Injected readers; no database.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/activity/operator-feed.test.ts
 */

import { readFileSync } from "node:fs";
import { AuditAction } from "@/lib/audit-actions";
import { buildOperatorActionData } from "@/lib/audit";
import { OPERATOR_ACTION_FEED_ACTIONS } from "@/lib/audit-actions";
import {
  OPERATOR_FEED_DEPTH, PLATFORM_OPS_FEED_ACTIONS, PLATFORM_OPS_FEED_RULES, SECURITY_ONLY_ACTIONS,
  admitsFeedRow, buildOperatorFeed, projectOperatorFeedItem, type OperatorFeedRowLike,
} from "./operator-feed-core";
import { loadOperatorFeed, type OperatorFeedReaders } from "./operator-feed";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = new Date("2026-10-14T12:00:00.000Z");
const at = (minsAgo: number) => new Date(NOW.getTime() - minsAgo * 60_000);

/** A row as the loader selects it, written through the real envelope builder. */
function envelopeRow(id: string, minsAgo: number, input: Parameters<typeof buildOperatorActionData>[0]): OperatorFeedRowLike {
  const data = buildOperatorActionData(input);
  return { id, action: data.action, createdAt: at(minsAgo), performedByAdminId: data.performedByAdminId ?? null, metadata: data.metadata };
}

const OP = { userId: "op_000001", via: "PLATFORM_GRANT" as const, area: "PLATFORM_OPS" };
const label = (id: string) => (id === "op_000001" ? "chris" : id === "op_000002" ? "Dana Ops" : null);

async function main() {
  console.log("1. the ruling: platform objects in, security events out");
  {
    check(`the allowlist is derived from the rule table (${PLATFORM_OPS_FEED_ACTIONS.length} actions)`,
      PLATFORM_OPS_FEED_ACTIONS.every((a) => a in PLATFORM_OPS_FEED_RULES) && PLATFORM_OPS_FEED_ACTIONS.length === Object.keys(PLATFORM_OPS_FEED_RULES).length);
    check("every admitted action is one the Security feed already lists (a subset, never a widening)",
      PLATFORM_OPS_FEED_ACTIONS.every((a) => OPERATOR_ACTION_FEED_ACTIONS.includes(a)));
    check("no security-only action is admitted", SECURITY_ONLY_ACTIONS.every((a) => !(a in PLATFORM_OPS_FEED_RULES)));
    // PLATFORM-SEC-1 adds the fleet-run intent row (PLATFORM_OPERATION_REQUESTED), a JOB target.
    const expected = ["PLATFORM_OPERATION_EXECUTED", "PLATFORM_OPERATION_DRY_RUN", "PLATFORM_OPERATION_REQUESTED", "JOB_CADENCE_CHANGED", "JOB_CADENCE_RESET",
      "PLATFORM_POLICY_CHANGED", "PLATFORM_POLICY_RESET", "CONNECTION_RESYNC_TRIGGERED", "CONNECTION_REAUTH_REQUESTED",
      "PLAID_ITEM_WEBHOOK_UPDATED", "PLAID_ITEM_REVOCATION_RETRY_REQUESTED", "OPERATOR_REFRESH_ALL",
      // A connection action (D6): resuming ONE wallet connection's history.
      "WALLET_HISTORY_RESUMED"].sort();
    check("the admitted set is exactly D6: job, connection, platform-setting, provider cleanup, Refresh All",
      [...PLATFORM_OPS_FEED_ACTIONS].sort().join() === expected.join(), PLATFORM_OPS_FEED_ACTIONS.join());
    check("every rule names a platform workspace doorway", Object.values(PLATFORM_OPS_FEED_RULES).every((r) => /^platform-/.test(r.workspace)));
  }

  console.log("\n2. admission by target kind");
  {
    const job = envelopeRow("a1", 1, { actor: OP, action: AuditAction.JOB_CADENCE_CHANGED, target: { kind: "JOB", id: "fetch-fx-rates" }, reason: { code: "TESTING" }, result: "SUCCESS" });
    check("a JOB-targeted cadence change is admitted", admitsFeedRow(job));
    const grant = envelopeRow("a2", 2, { actor: OP, action: AuditAction.PLATFORM_GRANT_CREATED, target: { kind: "USER", id: "u1" }, result: "SUCCESS" });
    check("a grant is refused by action", !admitsFeedRow(grant));
    const policyOnUser = envelopeRow("a3", 3, { actor: OP, action: AuditAction.CUSTOMER_POLICY_ASSIGNED, target: { kind: "USER", id: "u1" }, reason: { code: "SUPPORT_REQUEST" }, result: "SUCCESS" });
    check("a customer policy assignment is refused (Customer Success, not Platform Ops)", !admitsFeedRow(policyOnUser));
    const wrongKind: OperatorFeedRowLike = { id: "a4", action: AuditAction.JOB_CADENCE_CHANGED, createdAt: at(4), performedByAdminId: "op_000001",
      metadata: { actorType: "PLATFORM_OPERATOR", result: "SUCCESS", target: { kind: "USER", id: "u1" } } };
    check("an admitted action with a non-platform target kind is refused", !admitsFeedRow(wrongKind));
    const legacy: OperatorFeedRowLike = { id: "a5", action: AuditAction.CONNECTION_RESYNC_TRIGGERED, createdAt: at(5), performedByAdminId: "op_000001",
      metadata: { institution: "Chase", result: "SUCCESS" } };
    check("a pre-envelope resync row (no target) is admitted on its action", admitsFeedRow(legacy));
    const legacyCadence: OperatorFeedRowLike = { id: "a6", action: AuditAction.JOB_CADENCE_CHANGED, createdAt: at(6), performedByAdminId: "op_000001", metadata: {} };
    check("a cadence change without an envelope is refused (the envelope has always existed for it)", !admitsFeedRow(legacyCadence));
    const noOperator = { ...job, performedByAdminId: null };
    check("a row with no acting operator is refused", !admitsFeedRow(noOperator));
  }

  console.log("\n3. projection: opaque targets, operator label, evidence, no note / email / ip");
  {
    const refreshAll = envelopeRow("r1", 1, {
      actor: OP, action: AuditAction.OPERATOR_REFRESH_ALL, target: { kind: "USER", id: "cust_abcdef123456" },
      reason: { code: "SUPPORT_REQUEST", note: "customer asked on the phone" },
      execution: { refreshExecutionId: "exec_0000zz9999", jobRunId: null, commandId: null },
      result: "SUCCESS", ipAddress: "10.0.0.9", userAgent: "Mozilla/5.0 test",
      detail: { started: 2, cooldown: 1 },
    });
    const item = projectOperatorFeedItem(refreshAll, label("op_000001"));
    check("operator is the resolved label", item.operator === "chris");
    check("Refresh All target is OPAQUE (user …last6), never the customer's username", item.target === "user …123456");
    check("action label from the table", item.actionLabel === "Refreshed a customer's authorities");
    check("reason CODE only", item.reasonCode === "SUPPORT_REQUEST");
    check("evidence carries the refresh execution id and the workspace", item.evidence.refreshExecutionId === "exec_0000zz9999" && item.evidence.workspace === "platform-refresh" && item.evidence.jobRunId === undefined);
    const json = JSON.stringify(item);
    check("no note, ip, user-agent, email or metadata detail in the item", !/phone|10\.0\.0\.9|Mozilla|@|started|cooldown/.test(json), json);

    const run = envelopeRow("r2", 2, { actor: OP, action: AuditAction.PLATFORM_OPERATION_EXECUTED, target: { kind: "JOB", id: "sync-banks" },
      execution: { jobRunId: "run_000000abc123" }, result: "FAILURE" });
    const ri = projectOperatorFeedItem(run, null);
    check("unknown operator falls back to the word operator, never an id", ri.operator === "operator");
    check("a job run carries jobRunId + the Jobs workspace; result word preserved", ri.evidence.jobRunId === "run_000000abc123" && ri.evidence.workspace === "platform-jobs" && ri.result === "FAILURE" && ri.target === "job …-banks");

    const legacy: OperatorFeedRowLike = { id: "r3", action: AuditAction.CONNECTION_RESYNC_TRIGGERED, createdAt: at(3), performedByAdminId: "op_000002",
      metadata: { institution: "Chase", email: "someone@example.com", result: "SUCCESS" } };
    const li = projectOperatorFeedItem(legacy, label("op_000002"));
    check("legacy row: institution token as target, the name fallback as operator, and the email in metadata never surfaces",
      li.target === "Chase" && li.operator === "Dana Ops" && !/@/.test(JSON.stringify(li)));
  }

  console.log("\n4. the feed: ordering kept, depth stated, refused rows dropped, empty is honest");
  {
    const rows = [
      envelopeRow("f1", 1, { actor: OP, action: AuditAction.PLATFORM_POLICY_CHANGED, target: { kind: "PLATFORM_SETTING", id: "refresh_cadence_wallet" }, reason: { code: "POLICY_ROLLOUT" }, result: "SUCCESS" }),
      envelopeRow("f2", 2, { actor: OP, action: AuditAction.PLATFORM_GRANT_REVOKED, target: { kind: "USER", id: "u1" }, result: "SUCCESS" }),
      envelopeRow("f3", 3, { actor: OP, action: AuditAction.CONNECTION_REAUTH_REQUESTED, target: { kind: "PLAID_ITEM", id: "item_000000111222" }, result: "REFUSED" }),
    ];
    const feed = buildOperatorFeed(rows, label, NOW.toISOString());
    check("scope + depth + note", feed.scope === "PLATFORM_OPS" && feed.depth.requested === OPERATOR_FEED_DEPTH && feed.depth.returned === 2 && /Security Operations/.test(feed.note));
    check("the grant row is dropped; order is newest first", feed.items.map((i) => i.id).join() === "f1,f3");
    check("policy change: platform-setting target opaque, Policies workspace", feed.items[0].target === "platform setting …wallet" && feed.items[0].evidence.workspace === "platform-policies:defaults"); // PLATFORM OPS PHASE 1 UX — Policies › Platform defaults
    check("reauth: REFUSED result word kept, Providers workspace", feed.items[1].result === "REFUSED" && feed.items[1].evidence.workspace === "platform-providers");
    const empty = buildOperatorFeed([], label, NOW.toISOString());
    check("empty feed: zero items, depth returned 0, not an error", empty.items.length === 0 && empty.depth.returned === 0);
  }

  console.log("\n5. the loader: queries the allowlist at the stated depth, resolves operators without email");
  {
    const asked: { actions?: readonly string[]; take?: number; ids?: readonly string[] } = {};
    const readers: OperatorFeedReaders = {
      now: () => NOW,
      async rows(actions, take) {
        asked.actions = actions; asked.take = take;
        return [envelopeRow("l1", 1, { actor: OP, action: AuditAction.JOB_CADENCE_RESET, target: { kind: "JOB", id: "evaluate-alerts" }, reason: { code: "TESTING" }, result: "SUCCESS" })];
      },
      async operators(ids) {
        asked.ids = ids;
        return [{ id: "op_000001", username: "chris", name: "Chris H", ...({ email: "chris@example.com" } as object) }];
      },
    };
    const feed = await loadOperatorFeed({ readers });
    check("rows are asked for exactly the allowlist at OPERATOR_FEED_DEPTH", asked.actions?.join() === PLATFORM_OPS_FEED_ACTIONS.join() && asked.take === OPERATOR_FEED_DEPTH);
    check("operators resolved for the acting ids only", asked.ids?.join() === "op_000001");
    check("username first; an email on the identity row never reaches the payload", feed.items[0].operator === "chris" && !/@/.test(JSON.stringify(feed)));
    check("checkedAt is the reader's clock", feed.checkedAt === NOW.toISOString());
  }

  console.log("\n6. source: the loader reads through fm_system, selects no user relation, no email; the route gates PLATFORM_OPS READ first");
  {
    const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const loader = strip("lib/platform/activity/operator-feed.ts");
    check("systemDb only — never the migration principal", /systemDb/.test(loader) && !/\bdb\b\s*[.,]/.test(loader) && !/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/.test(loader));
    check("no user relation on the audit select (no subject username is ever loaded)", !/user:\s*\{/.test(loader));
    check("operator identity select is id / username / name only", /select: \{ id: true, username: true, name: true \}/.test(loader) && !/email/.test(loader));
    const route = strip("app/api/platform/platform-ops/activity/route.ts");
    check("route requires PLATFORM_OPS READ and returns the error first", /requirePlatformAccess\("PLATFORM_OPS", "READ"\)/.test(route) && /if \(err\) return err/.test(route));
    check("route never asks for SECURITY_OPS, WRITE or CONTROL, and exports no mutating verb", !/SECURITY_OPS|"WRITE"|"CONTROL"/.test(route) && !/export async function (POST|PUT|PATCH|DELETE)/.test(route));
    check("route imports no db", !/@\/lib\/db/.test(route));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
