/**
 * lib/transactions/flow-authority.test.ts
 *
 * v2.6-OWN-1 — the flow-ownership rule, pinned.
 *
 * These are the properties every write site depends on. The rule is four lines
 * of code; what makes it load-bearing is that the Plaid sync, the CSV import,
 * merchant corrections, the flowType backfill and five repair scripts all defer
 * to it. A regression here silently re-opens the defect the column closed:
 * approved transfer-authority repairs wearing the classifier's name, one
 * ownership-scoped backfill away from reversion.
 */

import {
  FLOW_AUTHORITIES,
  FLOW_AUTHORITY_LABEL,
  FLOW_AUTHORITY_SOURCE,
  FlowOwnershipError,
  assertMayWriteFlow,
  foreignFlowOwnershipFields,
  isClassifierCertifiable,
  isFlowAuthority,
  isFlowOwnershipCoupled,
  mayWriteFlow,
  type FlowAuthorityName,
} from "@/lib/transactions/flow-authority";

let passed = 0;
const failures: string[] = [];
function eq(label: string, got: unknown, want: unknown): void {
  if (got === want) { passed++; return; }
  failures.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function ok(label: string, cond: boolean): void { eq(label, cond, true); }

const OTHERS = FLOW_AUTHORITIES.filter((a) => a !== "CLASSIFIER");

// ── 1. An unowned row is adoptable by anyone ─────────────────────────────────
for (const a of FLOW_AUTHORITIES) {
  const v = mayWriteFlow(null, a);
  ok(`unowned adoptable by ${a}`, v.allowed);
  eq(`unowned kind for ${a}`, v.kind, "UNOWNED");
  // `undefined` (a read that did not select the column) must behave as unowned,
  // never as "some other authority" — a missing select is absence of knowledge.
  ok(`undefined treated as unowned for ${a}`, mayWriteFlow(undefined, a).allowed);
}

// ── 2. An authority may always refresh its own rows ──────────────────────────
for (const a of FLOW_AUTHORITIES) {
  const v = mayWriteFlow(a, a);
  ok(`${a} may refresh its own row`, v.allowed);
  eq(`${a} self-write kind`, v.kind, "SAME_AUTHORITY");
}

// ── 3. Cross-authority writes are REFUSED unless declared ────────────────────
// This is the property the whole slice rests on. Silence is refusal.
for (const owner of FLOW_AUTHORITIES) {
  for (const writer of FLOW_AUTHORITIES) {
    if (owner === writer) continue;
    const v = mayWriteFlow(owner, writer);
    eq(`${writer} may NOT silently overwrite ${owner}`, v.allowed, false);
    eq(`${writer}→${owner} kind`, v.kind, "REFUSED_FOREIGN");
    ok(`refusal names the displaced owner's module (${owner})`,
       v.reason.includes(FLOW_AUTHORITY_SOURCE[owner]));
  }
}

// ── 4. An EXPLICIT claim is the only way through ─────────────────────────────
{
  const v = mayWriteFlow("CLASSIFIER", "TRANSFER_AUTHORITY", ["CLASSIFIER"]);
  ok("declared claim is allowed", v.allowed);
  eq("declared claim kind", v.kind, "DECLARED_CLAIM");
  // A claim on a DIFFERENT authority does not open the door.
  eq("claim on an unrelated authority does not apply",
     mayWriteFlow("CRYPTO_LEDGER", "TRANSFER_AUTHORITY", ["CLASSIFIER"]).allowed, false);
  // An empty claim list is the default and must refuse.
  eq("empty claims refuse", mayWriteFlow("CRYPTO_LEDGER", "CLASSIFIER", []).allowed, false);
}

// ── 5. assertMayWriteFlow throws exactly when mayWriteFlow refuses ───────────
{
  let threw = false;
  try { assertMayWriteFlow("TRANSFER_AUTHORITY", "CLASSIFIER", "unit-test"); }
  catch (e) { threw = e instanceof FlowOwnershipError; }
  ok("assert throws FlowOwnershipError on a foreign write", threw);

  let threwOnOwn = false;
  try { assertMayWriteFlow("CLASSIFIER", "CLASSIFIER", "unit-test"); }
  catch { threwOnOwn = true; }
  eq("assert does not throw on a self-write", threwOnOwn, false);
}

// ── 6. Only the CLASSIFIER population is recomputable ───────────────────────
// audit:flow-desync certifies by re-running classifyFlow. Recomputing anything
// else proves nothing about that row and asserts ownership it does not have.
ok("CLASSIFIER is certifiable", isClassifierCertifiable("CLASSIFIER"));
for (const a of OTHERS) eq(`${a} is NOT certifiable`, isClassifierCertifiable(a), false);
eq("unowned is NOT certifiable", isClassifierCertifiable(null), false);
eq("undefined is NOT certifiable", isClassifierCertifiable(undefined), false);

// ── 7. The coupling invariant (audit INV-A) ─────────────────────────────────
ok("classified + owned is coupled", isFlowOwnershipCoupled({ flowType: "SPENDING", flowAuthority: "CLASSIFIER" }));
ok("unclassified + unowned is coupled", isFlowOwnershipCoupled({ flowType: null, flowAuthority: null }));
eq("classified but unowned is UNCOUPLED",
   isFlowOwnershipCoupled({ flowType: "SPENDING", flowAuthority: null }), false);
eq("owned but unclassified is UNCOUPLED",
   isFlowOwnershipCoupled({ flowType: null, flowAuthority: "CLASSIFIER" }), false);

// ── 8. A non-classifier stamp always clears the classifier's version ────────
// INV-C. Leaving the number behind is precisely what made the repairs look like
// classifier output; this helper exists so a repair cannot forget half the stamp.
for (const a of OTHERS as Exclude<FlowAuthorityName, "CLASSIFIER">[]) {
  const f = foreignFlowOwnershipFields(a);
  eq(`${a} stamps itself`, f.flowAuthority, a);
  eq(`${a} clears classifierVersion`, f.classifierVersion, null);
}

// ── 9. Every authority is labelled and sourced (extension path) ─────────────
// The maps are Record<FlowAuthorityName, …>, so this cannot fail at runtime
// without also failing to compile — which is the point: a new authority cannot
// ship anonymous.
for (const a of FLOW_AUTHORITIES) {
  ok(`${a} has a label`, (FLOW_AUTHORITY_LABEL[a]?.length ?? 0) > 0);
  ok(`${a} names its module`, (FLOW_AUTHORITY_SOURCE[a]?.length ?? 0) > 0);
}

// ── 10. The runtime type guard ──────────────────────────────────────────────
for (const a of FLOW_AUTHORITIES) ok(`isFlowAuthority accepts ${a}`, isFlowAuthority(a));
for (const bad of ["classifier", "REPAIR", "", null, undefined, 4, {}]) {
  eq(`isFlowAuthority rejects ${JSON.stringify(bad)}`, isFlowAuthority(bad), false);
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failures.length === 0) {
  console.log(`flow-authority: all ${passed} checks passed.`);
  process.exit(0);
} else {
  console.error(`flow-authority: ${failures.length} FAILED (of ${passed + failures.length}):`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
