/**
 * lib/platform/customer/assign.test.ts — the assignment service: one transaction
 * with its audit, reason required, unknown keys refused, cohorts append-only.
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/customer/assign.test.ts
 */
import { OperatorActionValidationError } from "@/lib/audit";
import { AssignmentRefusedError, assignCustomerCohort, assignCustomerPolicy, type AssignClient, type AssignTx } from "./assign";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function fakeClient(seed: { assignment?: { policyGroup: string; overlay: string | null } | null; cohorts?: string[] } = {}) {
  const state = { assignment: seed.assignment ?? null, cohorts: new Set(seed.cohorts ?? []), audits: [] as Record<string, unknown>[], txs: 0, rolledBack: 0 };
  const tx: AssignTx = {
    customerPolicyAssignment: {
      findUnique: async () => state.assignment ? { ...state.assignment, assignedAt: new Date("2026-10-01T00:00:00Z"), assignedById: "prev" } : null,
      upsert: async ({ create, update }) => { state.assignment = { policyGroup: update.policyGroup, overlay: update.overlay }; return { policyGroup: create.policyGroup, overlay: create.overlay, assignedAt: new Date("2026-10-08T00:00:00Z"), assignedById: create.assignedById }; },
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
