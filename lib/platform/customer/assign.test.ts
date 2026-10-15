/**
 * lib/platform/customer/assign.test.ts — the assignment service: one transaction
 * with its audit, reason required, unknown keys refused, cohorts append-only.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/assign.test.ts
 */
import { OperatorActionValidationError } from "@/lib/audit";
import { AI_ALLOWANCE_OVERRIDE_CEILING_USD, AssignmentRefusedError, assignCustomerCohort, assignCustomerPolicy, validateAllowanceOverride, type AssignClient, type AssignTx } from "./assign";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function fakeClient(seed: { assignment?: { policyGroup: string; overlay: string | null; aiDailyUsdAllowanceOverride?: number | null } | null; cohorts?: string[] } = {}) {
  const state = { assignment: seed.assignment ?? null, cohorts: new Set(seed.cohorts ?? []), audits: [] as Record<string, unknown>[], txs: 0, rolledBack: 0 };
  const tx: AssignTx = {
    customerPolicyAssignment: {
      findUnique: async () => state.assignment ? { ...state.assignment, assignedAt: new Date("2026-10-01T00:00:00Z"), assignedById: "prev" } : null,
      upsert: async ({ create, update }) => { state.assignment = { policyGroup: update.policyGroup, overlay: update.overlay, aiDailyUsdAllowanceOverride: update.aiDailyUsdAllowanceOverride }; return { policyGroup: create.policyGroup, overlay: create.overlay, assignedAt: new Date("2026-10-08T00:00:00Z"), assignedById: create.assignedById, aiDailyUsdAllowanceOverride: create.aiDailyUsdAllowanceOverride }; },
    },
    customerCohort: {
      findUnique: async ({ where }) => state.cohorts.has(where.userId_cohort.cohort) ? { id: "c" } : null,
      create: async ({ data }) => { state.cohorts.add(data.cohort); return { id: "c-new", joinedAt: new Date("2026-10-08T00:00:00Z") }; },
    },
    auditLog: { create: async ({ data }) => { state.audits.push(data as unknown as Record<string, unknown>); } },
  };
  const client: AssignClient = { $transaction: async (fn) => { state.txs++; const snapshot = { a: state.assignment, c: new Set(state.cohorts), n: state.audits.length }; try { return await fn(tx); } catch (e) { state.assignment = snapshot.a; state.cohorts = snapshot.c; state.audits.length = snapshot.n; state.rolledBack++; throw e; } } };
  return { client, state };
}
const actor = { userId: "op1", via: "PLATFORM_GRANT" as const };
const reason = { code: "BETA_ONBOARDING" as const };

(async () => {
  console.log("policy assignment");
  {
    const { client, state } = fakeClient();
    const e = await assignCustomerPolicy({ userId: "u1", policyGroup: "BETA_FULL_ACCESS_V1", reason, actor }, client);
    check("assigned and resolved", e.assigned && e.policyGroup === "BETA_FULL_ACCESS_V1");
    check("ONE transaction, ONE audit row inside it", state.txs === 1 && state.audits.length === 1);
    const a = state.audits[0];
    const m = a.metadata as Record<string, unknown>;
    check("audit row: customer as userId, operator as performedByAdminId, reason + change present", a.userId === "u1" && a.performedByAdminId === "op1" && (m.reason as { code: string }).code === "BETA_ONBOARDING" && (m.change as { after: { policyGroup: string } }).after.policyGroup === "BETA_FULL_ACCESS_V1");
    check("action is POLICY_ASSIGNED", a.action === "CUSTOMER_POLICY_ASSIGNED");
  }
  {
    const { client, state } = fakeClient({ assignment: { policyGroup: "BETA_FULL_ACCESS_V1", overlay: null } });
    const e = await assignCustomerPolicy({ userId: "u1", overlay: "FOUNDER_INTERNAL_V1", reason: { code: "DOGFOOD" }, actor }, client);
    check("overlay-only change is OVERLAY_CHANGED and keeps the group", state.audits[0].action === "CUSTOMER_POLICY_OVERLAY_CHANGED" && e.policyGroup === "BETA_FULL_ACCESS_V1" && e.overlay === "FOUNDER_INTERNAL_V1");
    const e2 = await assignCustomerPolicy({ userId: "u1", overlay: null, reason: { code: "DOGFOOD" }, actor }, client);
    check("overlay cleared with null", e2.overlay === null);
  }
  console.log("refusals");
  {
    const { client, state } = fakeClient();
    let refused = false; try { await assignCustomerPolicy({ userId: "u1", policyGroup: "NOPE", reason, actor }, client); } catch (e) { refused = e instanceof AssignmentRefusedError; }
    check("unknown policy group refused before any write", refused && state.txs === 0 && state.audits.length === 0);
    refused = false; try { await assignCustomerPolicy({ userId: "u1", overlay: "NOPE", reason, actor }, client); } catch (e) { refused = e instanceof AssignmentRefusedError; }
    check("unknown overlay refused", refused);
    refused = false; try { await assignCustomerPolicy({ userId: "u1", reason, actor }, client); } catch (e) { refused = e instanceof AssignmentRefusedError; }
    check("nothing-to-change refused", refused);
    let missing = false; try { await assignCustomerPolicy({ userId: "u1", policyGroup: "BETA_FULL_ACCESS_V1", reason: undefined as unknown as typeof reason, actor }, client); } catch (e) { missing = e instanceof OperatorActionValidationError; }
    check("missing reason refused by the chokepoint; nothing written", missing && state.audits.length === 0 && state.assignment === null);
  }
  console.log("AI COST CONTROLS — the per-customer allowance override");
  {
    const { client, state } = fakeClient({ assignment: { policyGroup: "BETA_FULL_ACCESS_V1", overlay: null } });
    const e = await assignCustomerPolicy({ userId: "u1", aiDailyUsdAllowanceOverride: 12, reason: { code: "SUPPORT_REQUEST" }, actor }, client);
    check("set: the override is stored and the effective allowance reports USER_OVERRIDE 12", state.assignment?.aiDailyUsdAllowanceOverride === 12 && e.aiDailyUsdAllowanceOverride === 12
      && e.dimensions.aiDailyUsdAllowance.value === 12 && e.dimensions.aiDailyUsdAllowance.source === "USER_OVERRIDE");
    const a = state.audits[0];
    const m = a.metadata as { reason: { code: string }; change: { before: Record<string, unknown>; after: Record<string, unknown> } };
    check("audited as CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED with reason + before/after figures, ONE transaction",
      a.action === "CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED" && m.reason.code === "SUPPORT_REQUEST" && m.change.before.aiDailyUsdAllowanceOverride === null && m.change.after.aiDailyUsdAllowanceOverride === 12 && state.txs === 1 && state.audits.length === 1);
    check("the override outranks the founder overlay", (await assignCustomerPolicy({ userId: "u1", overlay: "FOUNDER_INTERNAL_V1", reason, actor }, client)).dimensions.aiDailyUsdAllowance.source === "USER_OVERRIDE");
    const removed = await assignCustomerPolicy({ userId: "u1", aiDailyUsdAllowanceOverride: null, reason: { code: "TESTING" }, actor }, client);
    check("remove (null): the override is gone and the overlay's $20 is in force again", state.assignment?.aiDailyUsdAllowanceOverride === null && removed.aiDailyUsdAllowanceOverride === null
      && removed.dimensions.aiDailyUsdAllowance.source === "OVERLAY" && removed.dimensions.aiDailyUsdAllowance.value === 20 && state.audits[state.audits.length - 1].action === "CUSTOMER_AI_ALLOWANCE_OVERRIDE_CHANGED");
    const before = state.audits.length;
    for (const [bad, why] of [[21, "above the ceiling"], [0, "zero"], [-1, "negative"], [2.5, "non-integer"], ["5", "a string"]] as const) {
      let refused: unknown = null; try { await assignCustomerPolicy({ userId: "u1", aiDailyUsdAllowanceOverride: bad as never, reason, actor }, client); } catch (e) { refused = e; }
      check(`override ${why} is REFUSED (never clamped), nothing written`, refused instanceof AssignmentRefusedError && state.audits.length === before && state.assignment?.aiDailyUsdAllowanceOverride === null);
    }
    check("the ceiling the service refuses above is the catalogue's", AI_ALLOWANCE_OVERRIDE_CEILING_USD === 20 && validateAllowanceOverride(20).ok && !validateAllowanceOverride(21).ok);
    const { client: c2, state: s2 } = fakeClient();
    await assignCustomerPolicy({ userId: "u2", policyGroup: "BETA_FULL_ACCESS_V1", aiDailyUsdAllowanceOverride: 3, reason, actor }, c2);
    check("set together with the group ⇒ ONE row (POLICY_ASSIGNED) whose change carries the override too", s2.audits.length === 1 && s2.audits[0].action === "CUSTOMER_POLICY_ASSIGNED"
      && (s2.audits[0].metadata as { change: { after: { aiDailyUsdAllowanceOverride: number } } }).change.after.aiDailyUsdAllowanceOverride === 3);
    check("an undefined override keeps the stored one", (await assignCustomerPolicy({ userId: "u2", overlay: null, reason, actor }, c2)).aiDailyUsdAllowanceOverride === 3);
  }
  console.log("cohorts");
  {
    const { client, state } = fakeClient();
    const r1 = await assignCustomerCohort({ userId: "u1", cohort: "CLOSED_BETA_2026", reason, actor }, client);
    const r2 = await assignCustomerCohort({ userId: "u1", cohort: "CLOSED_BETA_2026", reason, actor }, client);
    check("first add is ADDED with an audit; second is ALREADY_MEMBER with none", r1.outcome === "ADDED" && r2.outcome === "ALREADY_MEMBER" && state.audits.length === 1);
    check("cohort audit carries source OPERATOR", (state.audits[0].metadata as { change: { after: { source: string } } }).change.after.source === "OPERATOR");
    let refused = false; try { await assignCustomerCohort({ userId: "u1", cohort: "NOPE", reason, actor }, client); } catch (e) { refused = e instanceof AssignmentRefusedError; }
    check("unknown cohort refused", refused);
  }
  if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nall checks passed");
})();
