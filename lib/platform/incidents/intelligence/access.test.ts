/**
 * lib/platform/incidents/intelligence/access.test.ts  (PB-1 Phase 2 — accessor access control)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/intelligence/access.test.ts
 *
 * The ACCESSORS (index.ts), driven end to end over an in-memory client that
 * counts every read. audience.test.ts pins the minter and the static call
 * sites, core.test.ts the pure tiering; this file pins what an accessor does
 * with a token AT RUNTIME:
 *   1. a wrong-tier or forged token is refused BEFORE any read (0 queries);
 *   2. PLATFORM_OPS output never carries `subjectUserId` (or a customer id
 *      anywhere in the payload), on every Ops-reachable accessor;
 *   3. `forCustomer` returns only that customer's incidents;
 *   4. `alertable` is reachable with the SYSTEM token only.
 */

import { UserRole } from "@prisma/client";
import { createIncidentAccessors, type IncidentFactsReader } from "./index";
import { incidentAudienceFor, systemIncidentAudience, IncidentAudienceError, type CsToken, type OpsToken } from "./audience";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-03T12:00:00Z");
const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

/** Synthetic rows: one open incident per customer, each on that customer's own item. */
const ROWS = [
  { id: "i_alice", plaidItemId: "item_alice", userId: "u_alice_0000000001" },
  { id: "i_bob", plaidItemId: "item_bob", userId: "u_bob_00000000002" },
].map((r) => ({
  id: r.id, kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: r.plaidItemId, financialAccountId: null,
  plaidTransactionId: null, detail: null, resolved: false, incidentKey: null, previousIncidentId: null,
  createdAt: ago(2), firstOccurredAt: ago(2), lastOccurredAt: ago(1), resolvedAt: null, resolutionKind: null,
  resolutionReasonCode: null, lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null,
  subjectUserId: null, causeStatus: null, causeCode: null, resolutionEvidence: null, _count: { occurrences: 1 },
  __owner: r.userId,
}));
const ITEMS = ROWS.map((r) => ({ id: r.plaidItemId, status: "ACTIVE", userId: r.__owner }));

let reads = 0;
type Where = Record<string, unknown> | undefined;
const inIds = (w: Where, k: string): string[] | null => {
  const v = (w?.[k] as { in?: string[] } | undefined)?.in;
  return Array.isArray(v) ? v : null;
};
/** The subset of `where` shapes the accessors issue; anything else returns everything (the core still filters). */
function matchRow(w: Where, r: (typeof ROWS)[number]): boolean {
  if (!w) return true;
  if (typeof w.id === "string") return r.id === w.id;
  if (w.resolved === false && r.resolved) return false;
  const or = w.OR as Where[] | undefined;
  if (or) {
    return or.some((c) =>
      (typeof c?.subjectUserId === "string" && r.subjectUserId === c.subjectUserId)
      || (inIds(c, "plaidItemId")?.includes(r.plaidItemId) ?? false)
      || (inIds(c, "financialAccountId") !== null && r.financialAccountId !== null && inIds(c, "financialAccountId")!.includes(r.financialAccountId)));
  }
  return true;
}
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: Where }) => { reads++; return ROWS.filter((r) => matchRow(a.where, r)); }) as never },
  syncIssueOccurrence: {
    findMany: (async () => { reads++; return []; }) as never,
    groupBy: (async () => { reads++; return []; }) as never,
  },
  syncIssueArchive: { findMany: (async () => { reads++; return []; }) as never },
  syncIssueRelation: { findMany: (async () => { reads++; return []; }) as never },
  financialAccount: { findMany: (async () => { reads++; return []; }) as never },
  plaidItem: {
    findMany: (async (a: { where?: Where }) => {
      reads++;
      const ids = inIds(a.where, "id");
      if (ids) return ITEMS.filter((i) => ids.includes(i.id));
      if (typeof a.where?.userId === "string") return ITEMS.filter((i) => i.userId === a.where!.userId);
      return ITEMS;
    }) as never,
  },
  stageAttempts: (async () => { reads++; return []; }) as never,
};
const acc = createIncidentAccessors(client);
const opts = { now: NOW };

// Minted from guard-shaped results; the minter returns the union, the grant fixes the tier.
const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;
const sys = systemIncidentAudience();
const forged = Object.freeze({ audience: "CUSTOMER_SUCCESS" });

async function refusedBeforeRead(name: string, fn: () => Promise<unknown>): Promise<void> {
  const before = reads;
  let refused = false;
  try { await fn(); } catch (e) { refused = e instanceof IncidentAudienceError; }
  check(`${name}: refused with IncidentAudienceError and ZERO reads`, refused && reads === before, { refused, reads: reads - before });
}

async function main(): Promise<void> {
  console.log("PB-1 Phase 2 — accessor access control\n\n1. refusal happens before any read");
  await refusedBeforeRead("forCustomer with a PLATFORM_OPS token", () => acc.forCustomer(ops as never, "u_alice_0000000001", opts));
  await refusedBeforeRead("forCustomer with the SYSTEM token", () => acc.forCustomer(sys as never, "u_alice_0000000001", opts));
  await refusedBeforeRead("alertable with a CS token", () => acc.alertable(cs as never, opts));
  await refusedBeforeRead("alertable with a PLATFORM_OPS token", () => acc.alertable(ops as never, opts));
  await refusedBeforeRead("brokenNow with the SYSTEM token", () => acc.brokenNow(sys as never, opts));
  await refusedBeforeRead("detail with the SYSTEM token", () => acc.detail(sys as never, "i_alice", opts));
  for (const [name, fn] of [
    ["brokenNow", () => acc.brokenNow(forged as never, opts)],
    ["history", () => acc.history(forged as never, opts)],
    ["needsVerification", () => acc.needsVerification(forged as never, opts)],
    ["detail", () => acc.detail(forged as never, "i_alice", opts)],
    ["forCustomer", () => acc.forCustomer(forged as never, "u_alice_0000000001", opts)],
    ["alertable", () => acc.alertable(forged as never, opts)],
  ] as const) await refusedBeforeRead(`${name} with a hand-built CS-shaped object`, fn);

  console.log("\n2. PLATFORM_OPS output is identity-free on every Ops-reachable accessor");
  const noIdentity = (x: unknown) => !/"subjectUserId"|u_alice_0000000001|u_bob_00000000002/.test(JSON.stringify(x));
  const opsBroken = await acc.brokenNow(ops, opts);
  check("brokenNow (Ops) lists both incidents", opsBroken.items.length === 2, opsBroken.items.map((v) => v.id));
  check("brokenNow (Ops) carries no subjectUserId key and no customer id", noIdentity(opsBroken));
  check("needsVerification (Ops) is identity-free", noIdentity(await acc.needsVerification(ops, opts)));
  check("history (Ops) is identity-free", noIdentity(await acc.history(ops, opts)));
  const opsDetail = await acc.detail(ops, "i_alice", opts);
  check("detail (Ops) returns the incident without identity", opsDetail?.id === "i_alice" && noIdentity(opsDetail));
  const csDetail = await acc.detail(cs, "i_alice", opts);
  check("detail (CS) names the attributed customer (control: the fixture CAN attribute)",
    (csDetail as { subjectUserId?: string } | null)?.subjectUserId === "u_alice_0000000001");

  console.log("\n3. forCustomer returns only that customer's incidents");
  const alice = await acc.forCustomer(cs, "u_alice_0000000001", opts);
  check("alice sees exactly her incident", alice.items.length === 1 && alice.items[0].id === "i_alice", alice.items.map((v) => v.id));
  check("…and it is attributed to her", alice.items.every((v) => v.subjectUserId === "u_alice_0000000001"));
  const nobody = await acc.forCustomer(cs, "u_nobody_00000000003", opts);
  check("a customer with no subjects sees nothing (never another customer's rows)", nobody.items.length === 0, nobody.items.map((v) => v.id));

  console.log("\n4. alertable is the SYSTEM tier's, and identity-free");
  const al = await acc.alertable(sys, opts);
  check("alertable (SYSTEM) answers", Array.isArray(al.items));
  check("alertable (SYSTEM) carries no customer identity", noIdentity(al));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\naccess.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
