/**
 * app/api/platform/platform-ops/policies/reconcile-beta/route.test.ts  (owner ruling, 2026-10-30)
 *
 * The REAL exported GET/POST handlers, real session cookies, the in-memory
 * Prisma fake (lib/test-support/route-harness.ts). Authorization runs through
 * the unmodified chain — session → require(Fresh)PlatformAccess → the
 * PlatformGrant row — never stubbed.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs app/api/platform/platform-ops/policies/reconcile-beta/route.test.ts
 *
 * Proves: GET is a PLATFORM_OPS READ dry run with counts only (active customers
 * with no row are eligible; deactivated, non-customer roles, already assigned —
 * Founder included — and unknown-group rows are excluded and counted); POST
 * needs fresh PLATFORM_OPS CONTROL and a structured reason; a changed
 * population is 409 with nothing written; the apply creates Beta rows ONLY for
 * the eligible, never touches an existing row (Founder, unknown group, or one
 * written concurrently), writes ONE counts-only audit row, and is idempotent.
 */

import "@/lib/test-support/route-env";
import { FakePrisma, installFakePrisma } from "@/lib/test-support/fake-prisma";
import { invoke, request, makeChecker, signIn, freshCache } from "@/lib/test-support/route-harness";
import { DEFAULT_POLICY_GROUP } from "@/lib/entitlements/catalogue";

const t = makeChecker("/api/platform/platform-ops/policies/reconcile-beta");
const fake = new FakePrisma();
let GET: typeof import("./route").GET;
let POST: typeof import("./route").POST;

const PATH = "/api/platform/platform-ops/policies/reconcile-beta";
const REASON = { code: "POLICY_ROLLOUT", note: "beta default for pre-ruling accounts" };

type DryRun = { eligible: number; groupKey: string; excluded: { deactivated: number; nonCustomerRoles: number; alreadyAssigned: number; unknownAssignments: number }; checkedAt: string };

let n = 0;
function account(opts: { role?: "USER" | "SYSTEM_ADMIN"; deactivated?: boolean; assignment?: { policyGroup: string; overlay?: string | null } } = {}) {
  n++;
  const u = fake.seed("User", {
    email: `acct${n}@example.test`, username: `acct${n}`, passwordHash: "x", emailVerifiedAt: new Date(),
    role: opts.role ?? "USER", deactivatedAt: opts.deactivated ? new Date("2026-10-01T00:00:00Z") : null,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)),
  });
  if (opts.assignment) {
    fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup: opts.assignment.policyGroup, overlay: opts.assignment.overlay ?? null, assignedById: "op_founder" });
  }
  return u.id as string;
}

/** An operator account: role USER WITH an assignment, so it never joins the eligible population. */
async function operator(name: string, grant: { area: string; level: string; status?: string } | null) {
  const u = fake.seed("User", { email: `${name}@example.test`, username: name, passwordHash: "x", emailVerifiedAt: new Date(), role: "USER" });
  fake.seed("CustomerPolicyAssignment", { userId: u.id, policyGroup: DEFAULT_POLICY_GROUP });
  if (grant) fake.seed("PlatformGrant", { userId: u.id, area: grant.area, level: grant.level, status: grant.status ?? "ACTIVE" });
  return signIn(fake, u.id as string);
}

async function main() {
  await installFakePrisma(fake);
  ({ GET, POST } = await import("./route"));
  fake.reset();
  freshCache();

  const read = await operator("reader", { area: "PLATFORM_OPS", level: "READ" });
  const write = await operator("writer", { area: "PLATFORM_OPS", level: "WRITE" });
  const otherArea = await operator("cs", { area: "CUSTOMER_SUCCESS", level: "CONTROL" });
  const revoked = await operator("revoked", { area: "PLATFORM_OPS", level: "CONTROL", status: "REVOKED" });
  const customer = await operator("customer", null);
  const control = await operator("controller", { area: "PLATFORM_OPS", level: "CONTROL" });
  const control2 = await operator("controller2", { area: "PLATFORM_OPS", level: "CONTROL" });
  // Validation probes are spread over two more holders so the 5/60 s limiter never answers first.
  const probeA = await operator("probe-a", { area: "PLATFORM_OPS", level: "CONTROL" });
  const probeB = await operator("probe-b", { area: "PLATFORM_OPS", level: "CONTROL" });

  // The population (6 operators above are assigned → alreadyAssigned 6).
  const eligibleA = account();
  const eligibleB = account();
  const eligibleC = account();
  const deactivated = account({ deactivated: true });
  const admin = account({ role: "SYSTEM_ADMIN" });
  const founder = account({ assignment: { policyGroup: DEFAULT_POLICY_GROUP, overlay: "FOUNDER_INTERNAL_V1" } });
  const retired = account({ assignment: { policyGroup: "RETIRED_GROUP_V0" } });
  const retiredDeactivated = account({ deactivated: true, assignment: { policyGroup: "RETIRED_GROUP_V0" } });

  const snapshot = () => JSON.stringify(fake.rows("CustomerPolicyAssignment").map((r) => [r.userId, r.policyGroup, r.overlay, r.assignedById, String(r.assignedAt)]).sort());
  const audits = () => fake.rows("AuditLog", { action: "CUSTOMER_POLICY_RECONCILED" });
  const get = (cookie?: string) => invoke<DryRun>(GET, request(PATH, { method: "GET", cookie }));
  const post = (cookie: string | undefined, body: unknown) => invoke<Record<string, unknown>>(POST, request(PATH, { method: "POST", cookie, body }));

  t.section("1. GET — the dry run is PLATFORM_OPS READ");
  t.check("anonymous → 401", (await get()).status === 401);
  t.check("a customer with no grant → 403", (await get(customer.cookie)).status === 403);
  t.check("CONTROL in another area → 403", (await get(otherArea.cookie)).status === 403);
  t.check("a REVOKED grant → 403", (await get(revoked.cookie)).status === 403);
  const dry = await get(read.cookie);
  t.check("PLATFORM_OPS READ → 200", dry.status === 200, dry.body);

  t.section("2. the dry-run math — active customers with no row; every exclusion counted");
  {
    const d = dry.body;
    t.check("eligible = the 3 active USER accounts with no row", d.eligible === 3, d);
    t.check("groupKey = DEFAULT_POLICY_GROUP (Beta)", d.groupKey === DEFAULT_POLICY_GROUP && /^BETA_/.test(d.groupKey));
    t.check("excluded.deactivated = 1 (deactivated customer, no row)", d.excluded.deactivated === 1, d.excluded);
    t.check("excluded.nonCustomerRoles = 1 (SYSTEM_ADMIN, no row)", d.excluded.nonCustomerRoles === 1, d.excluded);
    t.check("excluded.alreadyAssigned = 10 (9 operators + Founder — a catalogue group)", d.excluded.alreadyAssigned === 10, d.excluded);
    t.check("excluded.unknownAssignments = 2 (rows naming a retired group, any status)", d.excluded.unknownAssignments === 2, d.excluded);
    const users = fake.rows("User").length;
    t.check("the buckets partition every account exactly once", d.eligible + d.excluded.deactivated + d.excluded.nonCustomerRoles + d.excluded.alreadyAssigned + d.excluded.unknownAssignments === users, { users });
    t.check("counts only — the body names no account id, email or username",
      !new RegExp([eligibleA, eligibleB, eligibleC, deactivated, admin, founder, retired].join("|")).test(dry.text) && !/@|acct\d/.test(dry.text));
    t.check("the dry run wrote nothing", fake.callsTo("CustomerPolicyAssignment", "createMany").length === 0 && audits().length === 0);
  }

  t.section("3. POST — fresh PLATFORM_OPS CONTROL, then a structured reason");
  const before = snapshot();
  for (const [who, s, code] of [["anonymous", undefined, 401], ["a customer", customer, 403], ["PLATFORM_OPS READ", read, 403], ["PLATFORM_OPS WRITE (CONTROL is a rank above)", write, 403],
    ["CONTROL in another area", otherArea, 403], ["a REVOKED CONTROL grant", revoked, 403]] as const) {
    t.check(`${who} → ${code}`, (await post(s?.cookie, { reason: REASON, expectedEligible: 3 })).status === code);
  }
  {
    const noReason = await post(probeA.cookie, { expectedEligible: 3 });
    t.check("no reason → 400", noReason.status === 400, noReason.body);
    t.check("a bad reason code → 400", (await post(probeA.cookie, { reason: { code: "BECAUSE" }, expectedEligible: 3 })).status === 400);
    t.check("an unsafe note (long digit run) → 400", (await post(probeA.cookie, { reason: { code: "OTHER", note: "acct 4111111111111111" }, expectedEligible: 3 })).status === 400);
    t.check("a non-integer expectedEligible → 400", (await post(probeB.cookie, { reason: REASON, expectedEligible: "3" })).status === 400);
    t.check("a negative expectedEligible → 400", (await post(probeB.cookie, { reason: REASON, expectedEligible: -1 })).status === 400);
    t.check("a missing expectedEligible → 400 (count before change is required)", (await post(probeB.cookie, { reason: REASON })).status === 400);
    t.check("no body → 400", (await post(probeB.cookie, undefined)).status === 400);
    t.check("…and no refusal created or changed an assignment", snapshot() === before && audits().length === 0);
    const refusals = fake.rows("AuditLog", { action: "PLATFORM_CONTROL_REFUSED" });
    t.check("each refusal past the grant is recorded (PLATFORM_CONTROL_REFUSED, beta-reconciliation, never the note)",
      refusals.length === 7 && refusals.every((r) => (r.metadata as { control?: string }).control === "beta-reconciliation") && !JSON.stringify(refusals).includes("4111111111111111"));
  }

  t.section("4. the population changed — 409, nothing written");
  {
    const stale = await post(control.cookie, { reason: REASON, expectedEligible: 2 });
    t.check("expectedEligible 2 vs current 3 → 409 CONFLICT 'the population changed — re-check'",
      stale.status === 409 && stale.body.code === "CONFLICT" && /population changed/i.test(String(stale.body.error)), stale.body);
    t.check("…carries the current dry run (eligible 3)", (stale.body.dryRun as DryRun | undefined)?.eligible === 3);
    t.check("…and wrote nothing (no createMany, no reconciliation audit, rows unchanged)",
      fake.callsTo("CustomerPolicyAssignment", "createMany").length === 0 && audits().length === 0 && snapshot() === before);
  }

  t.section("5. the apply — Beta for the eligible only, existing rows untouched, a concurrent assignment wins");
  {
    // A concurrent Customer Success assignment lands for eligibleC between the
    // read and the insert (inside the transaction): it must win, never be overwritten.
    fake.on("CustomerPolicyAssignment", "createMany", () => {
      fake.seed("CustomerPolicyAssignment", { userId: eligibleC, policyGroup: DEFAULT_POLICY_GROUP, overlay: "FOUNDER_INTERNAL_V1", assignedById: "op_concurrent" });
      return undefined;
    }, { once: true });
    const ok = await post(control.cookie, { reason: REASON, expectedEligible: 3 });
    t.check("200 ASSIGNED: eligible 3, created 2, skipped 1", ok.status === 200 && ok.body.outcome === "ASSIGNED" && ok.body.eligible === 3 && ok.body.created === 2 && ok.body.skipped === 1, ok.body);
    t.check("…the after-dry-run reports eligible 0", (ok.body.dryRun as DryRun).eligible === 0);
    const calls = fake.callsTo("CustomerPolicyAssignment", "createMany");
    const args = calls[0]?.args as { data: Record<string, unknown>[]; skipDuplicates?: boolean };
    t.check("ONE createMany with skipDuplicates: true", calls.length === 1 && args.skipDuplicates === true);
    t.check("rows: Beta, no overlay, no allowance override, assignedById = the operator",
      args.data.length === 3 && args.data.every((d) => d.policyGroup === DEFAULT_POLICY_GROUP && d.overlay === null && d.aiDailyUsdAllowanceOverride === null && d.assignedById === control.userId));
    t.check("…for exactly the eligible accounts", args.data.map((d) => d.userId).sort().join() === [eligibleA, eligibleB, eligibleC].sort().join());
    const row = (id: string) => fake.one("CustomerPolicyAssignment", { userId: id });
    t.check("eligible accounts are now on Beta", row(eligibleA)?.policyGroup === DEFAULT_POLICY_GROUP && row(eligibleB)?.policyGroup === DEFAULT_POLICY_GROUP);
    t.check("the concurrent assignment WON (overlay + operator kept)", row(eligibleC)?.overlay === "FOUNDER_INTERNAL_V1" && row(eligibleC)?.assignedById === "op_concurrent");
    t.check("Founder untouched", row(founder)?.overlay === "FOUNDER_INTERNAL_V1" && row(founder)?.assignedById === "op_founder");
    t.check("unknown-group rows untouched (left for the fail-closed alert)", row(retired)?.policyGroup === "RETIRED_GROUP_V0" && row(retiredDeactivated)?.policyGroup === "RETIRED_GROUP_V0");
    t.check("deactivated and non-customer accounts got nothing", !row(deactivated) && !row(admin));
    t.check("no update / upsert / delete reached the assignment table",
      ["update", "updateMany", "upsert", "delete", "deleteMany"].every((op) => fake.callsTo("CustomerPolicyAssignment", op).length === 0));

    const a = audits();
    t.check("ONE CUSTOMER_POLICY_RECONCILED row", a.length === 1);
    const m = (a[0]?.metadata ?? {}) as Record<string, unknown>;
    t.check("…by the operator, targeting the POLICY_GROUP, with the reason",
      a[0]?.performedByAdminId === control.userId && a[0]?.userId == null
        && JSON.stringify(m.target) === JSON.stringify({ kind: "POLICY_GROUP", id: DEFAULT_POLICY_GROUP })
        && (m.reason as { code?: string })?.code === "POLICY_ROLLOUT");
    t.check("…carrying counts (eligible 3, created 2, skipped 1)", m.eligible === 3 && m.created === 2 && m.skipped === 1, m);
    const auditText = JSON.stringify(a[0]);
    t.check("…and no identity of any affected account",
      ![eligibleA, eligibleB, eligibleC].some((id) => auditText.includes(id)) && !/acct\d|@example/.test(auditText));
  }

  t.section("6. idempotent — a second run finds nobody and writes nothing");
  {
    const after = snapshot();
    const again = await post(control2.cookie, { reason: REASON, expectedEligible: 0 });
    t.check("200 NOTHING_TO_ASSIGN, created 0", again.status === 200 && again.body.outcome === "NOTHING_TO_ASSIGN" && again.body.created === 0, again.body);
    t.check("…no second createMany, no second audit row, rows unchanged",
      fake.callsTo("CustomerPolicyAssignment", "createMany").length === 1 && audits().length === 1 && snapshot() === after);
    const d = (await get(read.cookie)).body;
    t.check("the dry run now reports eligible 0; the deactivated and admin accounts still excluded (still fail closed)",
      d.eligible === 0 && d.excluded.deactivated === 1 && d.excluded.nonCustomerRoles === 1 && d.excluded.unknownAssignments === 2, d);
  }

  // The 5 / 60 s per-operator limiter is pinned at source in
  // lib/platform/policies/reconcile-beta.test.ts (route-env turns rate limiting off).

  t.done();
}

main().catch((e) => { console.error(e); process.exit(1); });
