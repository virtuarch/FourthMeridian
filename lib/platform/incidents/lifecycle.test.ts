/**
 * lib/platform/incidents/lifecycle.test.ts  (OPS-2D-5A-1)
 *
 * The incident lifecycle, against an in-memory client.
 *
 * The failures this guards are all "looks right, is wrong":
 *
 *   - keying on `kind` would merge an opening-position repair and a lost bank
 *     transaction into one incident, a merge no later taxonomy split could undo;
 *   - resolving by item would let a successful investments stage close a held
 *     transaction page it proved nothing about;
 *   - reopening a resolved row would erase the recovery episode that already
 *     happened;
 *   - treating `detail.runId` as a relation would attach occurrences to
 *     executions that do not exist, because syncTransactionsForItem mints its
 *     own UUID when no caller threads one.
 *
 * Run:  npx tsx lib/platform/incidents/lifecycle.test.ts
 */

import { buildIncidentKey, INCIDENT_KEY_VERSION, LEGACY_UNSPECIFIED } from "./identity";
import { recordIncidentObservation, resolveByAutomaticRecovery, RESOLUTION_KIND_AUTOMATIC,
         type IncidentClient } from "./lifecycle";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── In-memory client honouring the partial unique index ─────────────────────
type IssueRow = Record<string, unknown> & { id: string; incidentKey: string | null; resolved: boolean };
function makeClient(executions: { runId: string; id: string }[] = []) {
  const issues: IssueRow[] = [];
  const occurrences: Record<string, unknown>[] = [];
  let n = 0;
  const match = (row: IssueRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === "id" && typeof v === "object" && v && "in" in (v as object)) {
        return ((v as { in: string[] }).in).includes(row.id as string);
      }
      return row[k] === v;
    });
  const client = {
    syncIssue: {
      create: async ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
        // THE CONSTRAINT: one active episode per key. Modelled here because it
        // is the concurrency guarantee, not an implementation detail.
        if (data.incidentKey !== null && data.resolved === false &&
            issues.some((r) => r.incidentKey === data.incidentKey && r.resolved === false)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { ...data, id: `i${++n}` } as IssueRow;
        issues.push(row);
        void select;
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        issues.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) =>
        issues.filter((r) => (where ? match(r, where) : true)),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = issues.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hits = issues.filter((r) => match(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      },
    },
    syncIssueOccurrence: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `o${++n}` };
        occurrences.push(row);
        return row;
      },
    },
  };
  const lookup = async (runId: string) => executions.find((e) => e.runId === runId)?.id ?? null;
  return { client: client as unknown as IncidentClient, issues, occurrences, lookup };
}

const txFail = (item: string, runId?: string) => ({
  kind: "UPSERT_ERROR" as const, plaidItemId: item, plaidTransactionId: "tx1",
  runId: runId ?? null,
  detail: { stage: "transaction-persist", cursorBlocking: true, runId },
});

async function main() {
  // ── 1. Identity ─────────────────────────────────────────────────────────────
  console.log("1. identity is semantic, never textual");
  {
    const a = buildIncidentKey({ provider: "PLAID", plaidItemId: "it1", domain: "transactions", stage: "transaction-persist" });
    const b = buildIncidentKey({ provider: "PLAID", plaidItemId: "it1", domain: "transactions", stage: "transaction-persist" });
    check("same semantic problem → same key", a === b);
    check("different item → different key",
      a !== buildIncidentKey({ provider: "PLAID", plaidItemId: "it2", domain: "transactions", stage: "transaction-persist" }));
    // The load-bearing one: UPSERT_ERROR spans ≥5 unrelated failures today.
    check("different stage on the same item → different key",
      a !== buildIncidentKey({ provider: "PLAID", plaidItemId: "it1", domain: "investments", stage: "opening-position-repair" }));
    check("missing stage falls back to an explicit legacy marker",
      buildIncidentKey({ provider: "PLAID", plaidItemId: "it1", domain: "transactions" }).endsWith(LEGACY_UNSPECIFIED));
    check("the key is versioned", a.startsWith(`v${INCIDENT_KEY_VERSION}::`));
    check("no message text, timestamp or execution id in the key",
      !/\d{4}-\d{2}-\d{2}|Error|failed/i.test(a));
  }

  // ── 2. Detection & convergence ──────────────────────────────────────────────
  console.log("2. repeated failures converge on one episode");
  {
    const { client, issues, occurrences } = makeClient();
    const r1 = await recordIncidentObservation(txFail("it1"), client);
    const r2 = await recordIncidentObservation(txFail("it1"), client);
    check("first failure opens an episode", r1?.created === true);
    check("second failure joins it", r2?.created === false && r2?.incidentId === r1?.incidentId);
    check("one episode, two occurrences",
      issues.filter((i) => i.incidentKey !== null).length === 1 && occurrences.length === 2);
    check("lastOccurredAt advances", issues[0].lastOccurredAt !== undefined);

    const r3 = await recordIncidentObservation(txFail("it2"), client);
    check("same raw failure on another item → separate episode", r3?.incidentId !== r1?.incidentId);

    const r4 = await recordIncidentObservation(
      { kind: "UPSERT_ERROR", plaidItemId: "it1", detail: { stage: "opening-position-repair" } }, client);
    check("different semantic scope on the same item → separate episode", r4?.incidentId !== r1?.incidentId);
  }

  // ── 3. Events are evidence, never open conditions ───────────────────────────
  console.log("3. an event is evidence and can never be resolved");
  {
    const { client, issues } = makeClient();
    await recordIncidentObservation({ kind: "REMOVED_TOMBSTONE", plaidItemId: "it1", detail: { count: 2 } }, client);
    const ev = issues[0];
    check("event carries no incident identity", ev.incidentKey === null);
    check("event is stored resolved-inert (never active)", ev.resolved === true);
    check("event has no resolution timestamp — nothing was recovered", ev.resolvedAt === null);

    // Two events do NOT converge; each is its own observation.
    await recordIncidentObservation({ kind: "REMOVED_TOMBSTONE", plaidItemId: "it1", detail: { count: 3 } }, client);
    check("events never converge into one episode", issues.length === 2);

    const res = await resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, client);
    check("the resolver leaves events untouched", res.resolved === 0);
  }

  // ── 4. Correlation is looked up, never assumed ──────────────────────────────
  console.log("4. execution correlation is a lookup, not a name");
  {
    const { client, occurrences, lookup } = makeClient([{ runId: "run-real", id: "exec-1" }]);
    await recordIncidentObservation(txFail("it1", "run-real"), client, lookup);
    check("a real correlator stores the execution FK", occurrences[0].refreshExecutionId === "exec-1");
    check("the raw correlator is retained for diagnostics", occurrences[0].runId === "run-real");

    // syncTransactionsForItem mints its own UUID when nobody threads one.
    await recordIncidentObservation(txFail("it2", "run-orphan"), client, lookup);
    check("an orphan correlator stores NULL, not a fabricated link",
      occurrences[1].refreshExecutionId === null && occurrences[1].runId === "run-orphan");

    await recordIncidentObservation(txFail("it3"), client, lookup);
    check("no correlator at all → null", occurrences[2].refreshExecutionId === null);
  }

  // ── 5. Resolution matches semantic scope ────────────────────────────────────
  console.log("5. only a matching success resolves");
  {
    const { client, issues, lookup } = makeClient([{ runId: "run-ok", id: "exec-ok" }]);
    await recordIncidentObservation(txFail("it1"), client);
    // An unrelated condition on the same item must survive.
    await recordIncidentObservation(
      { kind: "UPSERT_ERROR", plaidItemId: "it1", detail: { stage: "investment-import-repair" } }, client);

    const res = await resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions", runId: "run-ok" }, client, lookup);
    check("exactly the transaction condition resolved", res.resolved === 1);
    const tx = issues.find((i) => (i.detail as Record<string, unknown>)?.stage === "transaction-persist")!;
    const inv = issues.find((i) => (i.detail as Record<string, unknown>)?.stage === "investment-import-repair")!;
    check("resolvedAt is set", tx.resolvedAt instanceof Date);
    check("resolution kind is AUTOMATIC_RECOVERY", tx.resolutionKind === RESOLUTION_KIND_AUTOMATIC);
    check("resolving execution is linked", tx.resolvingExecutionId === "exec-ok");
    check("`resolved` moves in lockstep with resolvedAt", tx.resolved === true);
    check("the unrelated investments condition is UNTOUCHED",
      inv.resolved === false && inv.resolvedAt === null && inv.resolutionKind === null);

    // Another item's success proves nothing here.
    const { client: c2, issues: i2 } = makeClient();
    await recordIncidentObservation(txFail("itA"), c2);
    await resolveByAutomaticRecovery({ plaidItemId: "itB", domain: "transactions" }, c2);
    check("a different item's success resolves nothing", i2[0].resolved === false);
  }

  // ── 6. Honest null when no execution proved it ──────────────────────────────
  console.log("6. a missing resolving execution stays null");
  {
    const { client, issues } = makeClient();
    await recordIncidentObservation(txFail("it1"), client);
    const res = await resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions", runId: "run-orphan" }, client, async () => null);
    check("resolved without inventing a link",
      res.resolved === 1 && issues[0].resolvingExecutionId === null);
  }

  // ── 7. Recurrence creates a new generation ──────────────────────────────────
  console.log("7. recurrence never reopens a resolved episode");
  {
    const { client, issues } = makeClient();
    const first = await recordIncidentObservation(txFail("it1"), client);
    await resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, client);
    const resolvedAtBefore = issues[0].resolvedAt;

    const second = await recordIncidentObservation(txFail("it1"), client);
    check("a new episode is created", second?.incidentId !== first?.incidentId && second?.created === true);
    check("it links to the prior episode",
      issues.find((i) => i.id === second!.incidentId)!.previousIncidentId === first!.incidentId);
    check("the resolved episode is immutable",
      issues[0].resolved === true && issues[0].resolvedAt === resolvedAtBefore);
    check("both episodes remain in history", issues.filter((i) => i.incidentKey !== null).length === 2);
  }

  // ── 8. Concurrency ──────────────────────────────────────────────────────────
  //
  // Two matching failures racing through find-or-create would both see "no
  // active episode". The partial unique index makes the loser fail; the loser
  // must then join the winner rather than surfacing an error to a producer whose
  // contract is "never throws".
  console.log("8. concurrent failures converge on ONE episode");
  {
    const { client, issues, occurrences } = makeClient();
    const results = await Promise.all([
      recordIncidentObservation(txFail("it1"), client),
      recordIncidentObservation(txFail("it1"), client),
      recordIncidentObservation(txFail("it1"), client),
    ]);
    check("all three observations succeeded", results.every((r) => r !== null));
    check("exactly ONE active episode exists",
      issues.filter((i) => i.incidentKey !== null && i.resolved === false).length === 1,
      String(issues.length));
    check("all three occurrences landed", occurrences.length === 3);
    check("every observation reports the same episode",
      new Set(results.map((r) => r!.incidentId)).size === 1);
  }

  // ── 9. Never throws ─────────────────────────────────────────────────────────
  console.log("9. detection failure never becomes the caller's problem");
  {
    const exploding = {
      syncIssue: { findFirst: async () => { throw new Error("db down"); } },
      syncIssueOccurrence: {}, refreshExecution: {},
    } as unknown as IncidentClient;
    let threw = false;
    try { await recordIncidentObservation(txFail("it1"), exploding); } catch { threw = true; }
    check("recordIncidentObservation swallows its own failure", !threw);
    let threw2 = false;
    try { await resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, exploding); } catch { threw2 = true; }
    check("resolveByAutomaticRecovery swallows its own failure", !threw2);
  }

  if (failures > 0) {
    console.error(`\nlifecycle.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nlifecycle.test: all passed.");
}

main();
