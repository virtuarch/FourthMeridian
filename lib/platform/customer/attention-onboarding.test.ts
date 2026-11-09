/**
 * lib/platform/customer/attention-onboarding.test.ts  (Customer Success — onboarding "needs help" reasons)
 *
 * The four onboarding reasons added to the ONE attention fold, each with a
 * positive and a negative case and its boundaries:
 *
 *   no_connection_24h  23 h vs 24 h after registering; any connection (bank, wallet, manual) clears it;
 *                      from 7 days `stalled` takes over (never both).
 *   link_exited        an exit in the last 7 days with no connection since; an exit followed by a
 *                      connection clears it; an exit older than 7 days does not count; only codes shown.
 *   import_failed /    the import-status verdicts: failed vs in progress + interrupted (stuck);
 *   import_stuck       in progress (not interrupted), complete, recovered, removed are not reasons.
 *
 * Plus: every reason has a text-only suggested action that never tells the operator to contact a
 * customer without owner approval; the "test" label marks reserved-domain accounts without
 * excluding them (OD-4); the overview stays counts-only; the reader stays read-only and bounded.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/attention-onboarding.test.ts
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCsOverview, type CsOverviewFacts } from "./overview-core";
import {
  ATTENTION_ACTIONS, ATTENTION_KEYS, ATTENTION_LABELS, ATTENTION_SHORT, CONTACT_REQUIRES_APPROVAL,
  attentionDetailOf, attentionOf, foldAttention, idsForAttention, linkExitDetail, linkExitFactOf, parseAttentionFilter,
  type ImportAttentionFact, type LinkExitFact,
} from "./attention-core";
import { RESERVED_TEST_EMAIL_WHERE, isReservedTestEmail } from "./population";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); }
}
const code = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date("2026-11-20T15:00:00.000Z");
const H = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * H);
const user = (id: string, createdHoursAgo: number) => ({ id, createdAt: ago(createdHoursAgo), emailVerifiedAt: ago(createdHoursAgo), acceptedTermsAt: null, deactivatedAt: null });
const zero = { HEALTHY: 0, STALE: 0, DEGRADED: 0, NEEDS_REAUTH: 0, ERROR: 0, REVOKED: 0 };
const plaid = (id: string, userId: string, createdHoursAgo: number, status = "ACTIVE") =>
  ({ id, userId, externalItemId: `ext_${id}`, createdAt: ago(createdHoursAgo), status, investmentsConsent: null, environment: null, plaidEnvironment: null });

function facts(over: Partial<CsOverviewFacts> & { users: ReturnType<typeof user>[] }): CsOverviewFacts {
  const { users, ...rest } = over;
  return {
    activeCustomerIds: new Set(users.map((u) => u.id)),
    deactivatedCustomers: 0,
    funnel: { users, firstSessions: [], firstAiTurns: [], firstBriefViews: [], lastEngagements: [], plaidItems: [], walletConnections: [], manualAssets: [] },
    reconnectOwners: [], incidentOwners: [], policyIssueOwners: [],
    connections: { total: 0, counts: zero, retired: { revoked: 0, ownerInactive: 0 } },
    incidentDays: [], incidentsFloor: false, openByKind: [],
    ...rest,
  };
}
const withFunnel = (f: CsOverviewFacts, part: Partial<CsOverviewFacts["funnel"]>): CsOverviewFacts => ({ ...f, funnel: { ...f.funnel, ...part } });

console.log("1. no_connection_24h — 23 h vs 24 h, any connection clears it, `stalled` from 7 d");
{
  const f = facts({ users: [user("h23", 23), user("h24", 24), user("h47", 47), user("d6", 6 * 24 + 23), user("d7", 7 * 24), user("bank", 30), user("wallet", 30), user("manual", 30)] });
  const g = withFunnel(f, {
    plaidItems: [plaid("p1", "bank", 29, "REVOKED")],
    walletConnections: [{ userId: "wallet", createdAt: ago(29), status: "ACTIVE" }],
    manualAssets: [{ userId: "manual", createdAt: ago(29) }],
  });
  const fold = foldAttention(g, NOW);
  const set = idsForAttention(fold, "no_connection_24h");
  check("negative: 23 h after registering is not yet a reason", !set.has("h23"));
  check("positive: exactly 24 h is a reason (boundary inclusive)", set.has("h24"));
  check("positive: 47 h and 6 d 23 h are reasons", set.has("h47") && set.has("d6"));
  check("at 7 days the customer is `stalled`, not `no_connection_24h` (never both)",
    !set.has("d7") && fold.sets.stalled.has("d7") && [...set].every((id) => !fold.sets.stalled.has(id)));
  check("negative: any connection clears it — a bank item (even revoked), a wallet, a manual asset",
    !set.has("bank") && !set.has("wallet") && !set.has("manual"), [...set]);
  check("the row's reasons say it", JSON.stringify(attentionOf(fold, "h24")) === JSON.stringify(["no_connection_24h"]));
  const inactive = foldAttention({ ...g, activeCustomerIds: new Set(["h23"]) }, NOW);
  check("negative: a deactivated (not active) account never needs help", !inactive.sets.no_connection_24h.has("h24"));
}

console.log("2. link_exited — an exit in 7 d with no connection since; codes only");
{
  const exits: LinkExitFact[] = [
    { userId: "x1", at: ago(2), stage: "REQUIRES_CREDENTIALS", errorCode: "INVALID_CREDENTIALS" },
    { userId: "x1", at: ago(30), stage: null, errorCode: "NONE" },
    { userId: "x2", at: ago(10), stage: "INSTITUTION_NOT_FOUND", errorCode: "NONE" },
    { userId: "after", at: ago(10), stage: null, errorCode: "INSTITUTION_DOWN" },
    { userId: "old", at: ago(7 * 24 + 1), stage: null, errorCode: "ITEM_LOCKED" },
    { userId: "retry", at: ago(1), stage: null, errorCode: "NONE" },
    { userId: "weird", at: ago(1), stage: "<script>", errorCode: "Example Bank: wrong password" },
  ];
  const f = withFunnel(facts({ users: ["x1", "x2", "after", "old", "retry", "weird"].map((id) => user(id, 200)), linkExits: exits }), {
    plaidItems: [plaid("pa", "after", 5), plaid("pr", "retry", 3)],
  });
  const fold = foldAttention(f, NOW);
  const set = fold.sets.link_exited;
  check("positive: an exit 2 h ago with no connection", set.has("x1"));
  check("positive: a clean cancel at institution search still counts (no connection followed)", set.has("x2"));
  check("negative: an exit followed by a successful connection", !set.has("after"));
  check("negative: an exit older than 7 days", !set.has("old"));
  check("positive: a NEW exit after an earlier connection (the latest exit decides)", set.has("retry"));
  check("detail is the LATEST exit's closed codes", attentionDetailOf(fold, "x1").link_exited === "exit code INVALID_CREDENTIALS at REQUIRES_CREDENTIALS",
    attentionDetailOf(fold, "x1"));
  check("a clean cancel reads 'closed without an error'", attentionDetailOf(fold, "x2").link_exited === "closed without an error at INSTITUTION_NOT_FOUND");
  check("privacy: a non-code value never reaches the detail (reads OTHER / no stage)",
    attentionDetailOf(fold, "weird").link_exited === "exit code OTHER" && !JSON.stringify([...fold.details.values()]).includes("Example Bank"), attentionDetailOf(fold, "weird"));
  check("linkExitDetail: null codes → OTHER", linkExitDetail({ stage: null, errorCode: null }) === "exit code OTHER");
  const row = linkExitFactOf({ userId: "u", createdAt: ago(1), metadata: { provider: "PLAID", stage: "REQUIRES_OAUTH", errorCode: "NONE", institution: "Example Bank", error_message: "x" } });
  check("the reader keeps only userId, time, stage and errorCode from the event metadata",
    row !== null && JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["at", "errorCode", "stage", "userId"]) && !JSON.stringify(row).includes("Example Bank"));
  check("an event without a user is dropped", linkExitFactOf({ userId: null, createdAt: ago(1), metadata: {} }) === null);
  check("non-object metadata reads no codes", JSON.stringify(linkExitFactOf({ userId: "u", createdAt: ago(1), metadata: [1] })) === JSON.stringify({ userId: "u", at: ago(1), stage: null, errorCode: null }));
}

console.log("3. import_failed vs import_stuck — the import-status verdicts");
{
  const v = (status: ImportAttentionFact["verdict"]["status"], interrupted = false, reason: ImportAttentionFact["verdict"]["reason"] = null) => ({ status, interrupted, reason });
  const recentImports: ImportAttentionFact[] = [
    { userId: "failed", verdict: v("failed", false, "STALLED") },
    { userId: "stuck", verdict: v("in_progress", true, "INTERRUPTED") },
    { userId: "running", verdict: v("in_progress", false) },
    { userId: "done", verdict: v("complete") },
    { userId: "recov", verdict: v("recovered", false, "INTERRUPTED") },
    { userId: "gone", verdict: v("removed") },
    { userId: "both", verdict: v("failed", false, "REAUTH_REQUIRED") },
    { userId: "both", verdict: v("in_progress", true, "PROVIDER_TIMEOUT") },
    { userId: "inactive", verdict: v("failed", false, "STALLED") },
  ];
  const ids = ["failed", "stuck", "running", "done", "recov", "gone", "both"];
  const fold = foldAttention(withFunnel(facts({ users: ids.map((id) => user(id, 100)), recentImports }), {
    plaidItems: ids.map((id, i) => plaid(`p${i}`, id, 50)),
  }), NOW);
  check("positive: failed ⇒ import_failed (not stuck)", fold.sets.import_failed.has("failed") && !fold.sets.import_stuck.has("failed"));
  check("positive: in progress + interrupted ⇒ import_stuck (not failed)", fold.sets.import_stuck.has("stuck") && !fold.sets.import_failed.has("stuck"));
  check("negative: in progress (not interrupted), complete, recovered, removed are not reasons",
    ["running", "done", "recov", "gone"].every((id) => !fold.sets.import_failed.has(id) && !fold.sets.import_stuck.has(id)));
  check("two connections: one failed, one stuck ⇒ both reasons", fold.sets.import_failed.has("both") && fold.sets.import_stuck.has("both"));
  check("negative: a non-active owner is never named", !fold.union.has("inactive"));
  check("details are the import reason in words (category only)",
    attentionDetailOf(fold, "failed").import_failed === "no progress for over 24 h" && attentionDetailOf(fold, "stuck").import_stuck === "process ended mid-run"
    && attentionDetailOf(fold, "both").import_failed === "bank sign-in required");
  check("no facts ⇒ nobody (a caller without the read flags no one)",
    foldAttention(facts({ users: [user("failed", 100)] }), NOW).sets.import_failed.size === 0);
}

console.log("4. every reason: label, chip word, text-only action that gates customer contact");
{
  check("nine reasons, in display order", JSON.stringify(ATTENTION_KEYS) === JSON.stringify([
    "reconnect", "incident", "import_failed", "import_stuck", "link_exited", "policy", "unassigned", "no_connection_24h", "stalled"]));
  check("every reason parses as a filter", ATTENTION_KEYS.every((k) => parseAttentionFilter(k) === k));
  check("every reason has a label, a chip word and an action", ATTENTION_KEYS.every((k) => ATTENTION_LABELS[k] && ATTENTION_SHORT[k] && ATTENTION_ACTIONS[k]));
  const customerFacing = ATTENTION_KEYS.filter((k) => k !== "policy" && k !== "unassigned");
  check("every customer-facing action says customer contact requires owner approval",
    customerFacing.every((k) => ATTENTION_ACTIONS[k].endsWith(CONTACT_REQUIRES_APPROVAL)), customerFacing.filter((k) => !ATTENTION_ACTIONS[k].endsWith(CONTACT_REQUIRES_APPROVAL)));
  check("no action tells the operator to contact, email, message or call the customer",
    ATTENTION_KEYS.every((k) => !/\b(contact|e-?mail|message|call|reach out to|ask) the customer\b/i.test(ATTENTION_ACTIONS[k].replace(CONTACT_REQUIRES_APPROVAL, ""))));
  const o = buildCsOverview(facts({ users: [user("u", 30)] }), NOW, 30);
  check("the overview carries each reason's action", o.attention.reasons.every((r) => r.action === ATTENTION_ACTIONS[r.key]));
  const lead = code("components/platform/leads/CustomerSuccessLead.tsx");
  const widget = code("components/platform/widgets/CsCustomersWidget.tsx");
  check("the actions render as text (no fetch / send / mailto in the next-steps block or the chip)",
    /data-attention-next-steps/.test(lead) && !/mailto:|\/api\/[^"`]*send|comms/i.test(lead.slice(lead.indexOf("data-attention-next-steps"), lead.indexOf("data-attention-next-steps") + 800))
    && /data-needs-help-next/.test(widget) && !/mailto:/.test(widget));
}

console.log("5. the 'test' label (OD-4 undecided — labelled, never excluded)");
{
  check("reserved domains are labelled", ["synthetic-operator@example.test", "a@example.com", "b@sub.example.org", "C@Foo.TEST", "x@host.invalid"].every(isReservedTestEmail));
  check("real-looking domains are not", ["a@gmail.com", "b@examples.com", "c@example.co", "d@testing.io", "e@test.com", "bad", "a@b@example.test"].every((e) => !isReservedTestEmail(e)));
  check("the DB fragment mirrors the suffix list", RESERVED_TEST_EMAIL_WHERE.OR.length === 10 && RESERVED_TEST_EMAIL_WHERE.OR.every((c) => c.email.mode === "insensitive"));
  const f = facts({ users: [user("t", 30), user("r", 30)], testAccountIds: ["t"] });
  const fold = foldAttention(f, NOW);
  check("a test account still needs help and is still counted", fold.union.has("t") && fold.union.has("r") && fold.union.size === 2);
  const o = buildCsOverview(f, NOW, 30);
  check("the overview says how many of them are labelled test, and counts them", o.attention.testAccounts === 1 && o.attention.customers === 2);
  check("no test ids ⇒ 0", buildCsOverview(facts({ users: [user("r", 30)] }), NOW, 30).attention.testAccounts === 0);
  const list = code("lib/platform/customer/customers.ts");
  check("the list labels each row from its e-mail and filters nobody out", /testAccount: isReservedTestEmail\(u\.email\)/.test(list) && !/isReservedTestEmail\([^)]*\)\s*\)?\s*\?\s*\[\]/.test(list));
}

console.log("6. privacy + read-only (S2 conditions a, c, f)");
{
  const f = withFunnel(facts({
    users: [user("x1", 30)],
    linkExits: [{ userId: "x1", at: ago(1), stage: "REQUIRES_CREDENTIALS", errorCode: "INVALID_CREDENTIALS" }],
    recentImports: [{ userId: "x1", verdict: { status: "failed", interrupted: false, reason: "PROVIDER_ERROR" } }],
    testAccountIds: ["x1"],
  }), {});
  const o = JSON.stringify(buildCsOverview(f, NOW, 30));
  check("the overview DTO stays counts-only (no id, no exit code, no detail)", !o.includes('"x1"') && !o.includes("INVALID_CREDENTIALS") && !o.includes("userId"));
  const reader = code("lib/platform/customer/attention.ts");
  check("the reader writes nothing", !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\$queryRaw|fetch\(/.test(reader));
  check("the exits read is the product event, windowed by (action, createdAt), capped",
    /auditLog\.findMany\(\{ where: \{ action: AuditAction\.CONNECTION_LINK_EXITED, createdAt: \{ gte: exitFrom \} \}, select: \{ userId: true, createdAt: true, metadata: true \}, orderBy: \{ createdAt: "desc" \}, take: cap \}\)/.test(reader));
  check("imports: recent items picked from the funnel facts, read by primary key", /loadImportsForItemIds\(recentItemIds, now, client\)/.test(reader)
    && /where: \{ id: \{ in: ids \} \}/.test(code("lib/platform/onboarding/import-facts.ts")));
  check("the test label read selects ids only", /client\.user\.findMany\(\{ where: \{ AND: \[OPEN_CUSTOMER_WHERE, RESERVED_TEST_EMAIL_WHERE\] \}, select: \{ id: true \}, take: cap \}\)/.test(reader));
  const route = code("app/api/platform/customer-success/overview/route.ts");
  check("the overview route keeps its CUSTOMER_SUCCESS READ gate", /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\)/.test(route));
}

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
