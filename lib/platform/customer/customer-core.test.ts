/**
 * lib/platform/customer/customer-core.test.ts — pure projections of the customer
 * spine: provenance survives, forbidden material never crosses, authorities are named.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/customer-core.test.ts
 */
import { resolveEffectiveEntitlements } from "@/lib/entitlements/resolve";
import {
  actionTouchesItems, firstConnectedAt, projectActivity, projectAiUsage, projectCohorts, projectConnections, projectIdentity,
  projectIncidents, projectLifecycle, projectOperatorAction, projectPolicy, projectSpaces, requestStage, operatorDisplayName,
} from "./customer-core";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const T = (s: string) => new Date(s);
const NOW = T("2026-10-08T12:00:00Z").getTime();

console.log("identity — allowlist only");
{
  const row = { id: "u1", email: "a@example.test", name: "A", username: "a", role: "USER", createdAt: T("2026-10-01T00:00:00Z"), emailVerifiedAt: null,
    deactivatedAt: null, deletionRequestedAt: null, deletionScheduledAt: null,
    ...({ passwordHash: "HASH", totpSecret: "SECRET" } as object) };
  const out = JSON.stringify(projectIdentity(row));
  check("email and name resolve (CUSTOMER_SUCCESS may)", out.includes("a@example.test") && out.includes('"name":"A"'));
  check("no credential material", !/HASH|SECRET|passwordHash|totpSecret/.test(out));
}

console.log("policy provenance");
{
  const p = projectPolicy(resolveEffectiveEntitlements({ policyGroup: "BETA_FULL_ACCESS_V1", overlay: "FOUNDER_INTERNAL_V1", assignedAt: T("2026-10-08T00:00:00Z"), assignedById: "op" }));
  check("labels resolve from the catalogue", p.policyGroupLabel.startsWith("Beta") && p.overlayLabel !== null);
  check("every dimension carries source + explanation", p.dimensions.every((d) => d.source && d.explanation.length > 0));
  check("an overlaid dimension says OVERLAY and keeps the policy value", p.dimensions.find((d) => d.key === "exportsPerDay")!.source === "OVERLAY" && p.dimensions.find((d) => d.key === "exportsPerDay")!.policyValue === 3);
  const d = projectPolicy(resolveEffectiveEntitlements(null));
  check("unassigned is reported, not hidden", !d.assigned && d.dimensions.every((x) => x.source === "POLICY_DEFAULT"));
}

console.log("cohorts");
{
  const c = projectCohorts([{ cohort: "CLOSED_BETA_2026", joinedAt: T("2026-10-08T00:00:00Z"), source: "INVITE" }, { cohort: "OLD", joinedAt: T("2026-01-01T00:00:00Z"), source: "OPERATOR" }]);
  check("known cohort labelled, unknown kept with its key", c[0].known && c[0].label !== "CLOSED_BETA_2026" && !c[1].known && c[1].label === "OLD");
}

console.log("lifecycle");
{
  const v = projectLifecycle({ request: { id: "r", status: "REDEEMED", createdAt: T("2026-09-01T00:00:00Z"), decidedAt: T("2026-09-02T00:00:00Z"), invitedAt: T("2026-09-02T00:00:00Z"), inviteExpiresAt: null, redeemedAt: T("2026-09-03T00:00:00Z") },
    requestCount: 2, firstSource: { utmSource: "x" }, inviteEmail: { status: "sent", at: T("2026-09-02T00:00:00Z") }, registeredAt: T("2026-09-03T00:00:00Z"), firstConnectedAt: T("2026-09-04T00:00:00Z") });
  check("connected customer is CONNECTED", v.stage === "CONNECTED" && v.request?.requestCount === 2 && v.inviteEmail?.status === "sent");
  const w = projectLifecycle({ request: null, requestCount: 0, firstSource: null, inviteEmail: null, registeredAt: T("2026-09-03T00:00:00Z"), firstConnectedAt: null });
  check("registered without connection or request", w.stage === "REGISTERED" && w.request === null);
  check("request stages map", requestStage(null) === "NO_REQUEST" && requestStage("PENDING") === "REQUESTED" && requestStage("APPROVED") === "INVITED" && requestStage("DENIED") === "DENIED");
}

console.log("spaces");
{
  const s = projectSpaces([
    { role: "OWNER", status: "ACTIVE", joinedAt: T("2026-09-03T00:00:00Z"), space: { id: "s1", name: "Mine", type: "PERSONAL", category: "PERSONAL", archivedAt: null, deletedAt: null } },
    { role: "MEMBER", status: "ACTIVE", joinedAt: T("2026-09-03T00:00:00Z"), space: { id: "s2", name: "Gone", type: "SHARED", category: "FAMILY", archivedAt: null, deletedAt: T("2026-09-05T00:00:00Z") } },
  ]);
  check("deleted Space dropped; roles typed as strings", s.length === 1 && s[0].role === "OWNER");
}

console.log("activity — which authority answered");
{
  const a = projectActivity({ lastSessionActiveAt: T("2026-10-08T10:00:00Z"), lastLoginAt: T("2026-10-07T00:00:00Z"), activeSessions: 1 });
  check("session clock wins when newer", a.lastActiveSource === "SESSION");
  const b = projectActivity({ lastSessionActiveAt: null, lastLoginAt: T("2026-10-07T00:00:00Z"), activeSessions: 0 });
  check("LOGIN audit is the fallback", b.lastActiveSource === "LOGIN");
  check("nothing recorded says so", projectActivity({ lastSessionActiveAt: null, lastLoginAt: null, activeSessions: 0 }).lastActiveSource === "NONE");
}

console.log("connections — health from the shared derivation, no secrets");
{
  const plaid = [{ id: "p1", institutionName: "Chase", status: "ACTIVE", errorCode: null, lastSyncedAt: T("2026-10-08T11:00:00Z"), createdAt: T("2026-09-04T00:00:00Z"), investmentsConsent: "ENABLED",
    ...({ encryptedToken: "v2:TOKEN", cursor: "CURSOR", balance: 123.45 } as object) }];
  const wallets = [{ id: "c1", provider: "WALLET", externalConnectionId: "bc1qabcdef123456", status: "ACTIVE", errorCode: null, lastSyncedAt: T("2026-10-01T00:00:00Z"), createdAt: T("2026-09-10T00:00:00Z"),
    ...({ credential: "xpubSECRET" } as object) }];
  const rows = projectConnections(plaid, wallets, { bank: 26 * 3_600_000, wallet: 8 * 3_600_000 }, NOW);
  const out = JSON.stringify(rows);
  check("fresh bank is HEALTHY; week-old wallet is STALE", rows[0].healthState === "HEALTHY" && rows[1].healthState === "STALE");
  check("no token/cursor/credential/balance in the payload", !/TOKEN|CURSOR|xpub|123\.45|balance/.test(out));
  check("wallet label is an opaque tail", rows[1].label === "Wallet …123456");
  check("first connection is the earliest createdAt", firstConnectedAt(plaid, wallets)?.toISOString() === "2026-09-04T00:00:00.000Z");
}

console.log("incidents");
{
  const v = projectIncidents(
    [{ id: "i1", provider: "PLAID", kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: "p1", financialAccountId: null, firstOccurredAt: null, lastOccurredAt: null, createdAt: T("2026-10-07T00:00:00Z"), resolved: false },
     { id: "i2", provider: "PLAID", kind: "UPSERT_ERROR", plaidItemId: "p1", financialAccountId: null, firstOccurredAt: null, lastOccurredAt: null, createdAt: T("2026-10-07T00:00:00Z"), resolved: true }],
    [{ id: "e1", sourceKind: "PLAID_ITEM", plaidItemId: "p1", sourceRef: null, trigger: "MANUAL", profile: "FULL_REFRESH", overallStatus: "SUCCEEDED", startedAt: T("2026-10-08T00:00:00Z"), durationMs: 1200, failureCategory: null }],
    [{ receivedAt: T("2026-10-08T01:00:00Z"), webhookType: "TRANSACTIONS", webhookCode: "SYNC_UPDATES_AVAILABLE", handling: "SYNC_SCHEDULED", plaidItemId: "p1", errorCode: null }]);
  check("only open incidents listed; createdAt backs missing occurrence clocks", v.open.length === 1 && v.open[0].firstOccurredAt === "2026-10-07T00:00:00.000Z");
  check("executions and webhooks projected", v.recentExecutions[0].overallStatus === "SUCCEEDED" && v.recentWebhooks[0].handling === "SYNC_SCHEDULED");
}

console.log("AI usage — returned calls priced, failures counted, estimate labelled");
{
  const rows = [
    { provider: "OPENAI", model: "gpt-5.1", occurredAt: T("2026-10-08T00:00:00Z"), outcome: "RETURNED", conversationId: "c1", surface: "chat", promptTokens: 1000, cachedPromptTokens: 500, completionTokens: 200, latencyMs: 900 },
    { provider: "OPENAI", model: "gpt-5.1", occurredAt: T("2026-10-08T00:01:00Z"), outcome: "RETURNED", conversationId: "c1", surface: "chat", promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 100, latencyMs: 900 },
    { provider: "OPENAI", model: "gpt-5.1", occurredAt: T("2026-10-08T00:02:00Z"), outcome: "QUOTA", conversationId: "c2", surface: "brief", promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, latencyMs: 50 },
  ];
  const v = projectAiUsage(rows, 30);
  check("counts by outcome and surface", v.byOutcome.RETURNED === 2 && v.byOutcome.QUOTA === 1 && v.bySurface.chat === 2 && v.conversations === 2);
  check("tokens sum returned calls only", v.promptTokens === 2000 && v.completionTokens === 300);
  check("estimate is a number or honestly null, and labelled", (v.estimatedUsd === null || v.estimatedUsd > 0) && /estimate/i.test(v.estimateNote) && /not the provider invoice/.test(v.estimateNote));
  check("last failure recorded", v.lastFailureAt === "2026-10-08T00:02:00.000Z");
}

console.log("operator actions");
{
  const p1 = projectOperatorAction({ id: "a1", action: "CUSTOMER_POLICY_ASSIGNED", createdAt: T("2026-10-08T00:00:00Z"), performedByAdminId: "op",
    metadata: { actorType: "PLATFORM_OPERATOR", result: "SUCCESS", target: { kind: "USER", id: "u1" }, reason: { code: "DOGFOOD", note: "ok" }, change: { before: null, after: { policyGroup: "X" } } } });
  check("P1 envelope projected", p1.reasonCode === "DOGFOOD" && p1.note === "ok" && p1.target?.kind === "USER" && p1.result === "SUCCESS");
  const legacy = projectOperatorAction({ id: "a2", action: "ACCOUNT_DEACTIVATED", createdAt: T("2026-10-01T00:00:00Z"), performedByAdminId: "op", metadata: { by: "platform-operator", email: "x@y.z" } });
  check("legacy row projects without reason and drops the email", legacy.reasonCode === null && !JSON.stringify(legacy).includes("x@y.z"));
  check("connection action matched by legacy key", actionTouchesItems({ id: "a3", action: "CONNECTION_RESYNC_TRIGGERED", createdAt: T("2026-10-01T00:00:00Z"), performedByAdminId: "op", metadata: { connectionId: "p1" } }, new Set(["p1"])));
  check("…and not for another customer's item", !actionTouchesItems({ id: "a4", action: "CONNECTION_RESYNC_TRIGGERED", createdAt: T("2026-10-01T00:00:00Z"), performedByAdminId: "op", metadata: { connectionId: "p9" } }, new Set(["p1"])));
}


console.log("operator identity label — username first, never email");
{
  check("username wins", operatorDisplayName({ id: "abcdefgh123456", username: "chrstn", name: "Chris" }) === "chrstn");
  check("name when the username is missing", operatorDisplayName({ id: "abcdefgh123456", username: null, name: "Chris" }) === "Chris");
  check("opaque reference when both are missing", operatorDisplayName({ id: "abcdefgh123456", username: "  ", name: null }) === "user …123456");
  check("never derived from an email", !/@/.test(operatorDisplayName({ id: "x1y2z3", username: null, name: null, ...({ email: "someone@example.com" } as object) })));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
