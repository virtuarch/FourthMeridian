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
         RECOVERY_RULE_TRANSACTIONS_SYNCED, RECOVERY_RULE_BALANCE_OBSERVED,
         type IncidentClient } from "./lifecycle";
import { digestStoredEvidence, mayAdvanceRecovery, reshapeStoredEvidence, type ResolutionEvidence } from "./evidence";

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
  const events: Record<string, unknown>[] = [];
  let n = 0;
  const match = (row: IssueRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === "id" && typeof v === "object" && v && "in" in (v as object)) {
        return ((v as { in: string[] }).in).includes(row.id as string);
      }
      // A column the fake never wrote reads as NULL, like the real one.
      return (row[k] ?? null) === v;
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
    syncIssueEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `e${++n}` };
        events.push(row);
        return row;
      },
    },
    // OPS-2D-TX-1 — this fake stands in for a ROOT client, and `IncidentClient`
    // now requires `$transaction` so a caller's `Prisma.TransactionClient`
    // cannot be passed. P8 #1 — the lifecycle's OWN transition transaction (the
    // resolver's CAS + STATE_CHANGED event) runs on it; a throw rolls the
    // episode rows back, like the real one.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = issues.map((r) => ({ ...r }));
      const evCount = events.length;
      try { return await fn({ syncIssue: client.syncIssue, syncIssueEvent: client.syncIssueEvent }); }
      catch (e) { issues.splice(0, issues.length, ...snapshot); events.splice(evCount); throw e; }
    },
  };
  const lookup = async (runId: string) => executions.find((e) => e.runId === runId)?.id ?? null;
  return { client: client as unknown as IncidentClient, issues, occurrences, events, lookup };
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

    // ── OPS-2D-5A-2 — namespace safety ───────────────────────────────────────
    // The same literal id can name an item, an account and a wallet. Without
    // type prefixes those three would collide into ONE episode, silently merging
    // a bank connection with an account repair and a wallet sync.
    const asItem   = buildIncidentKey({ provider: "PLAID", plaidItemId: "abc", domain: "transactions", stage: "s" });
    const asAcct   = buildIncidentKey({ provider: "PLAID", plaidItemId: null, scope: { kind: "FINANCIAL_ACCOUNT", id: "abc" }, domain: "transactions", stage: "s" });
    const asWallet = buildIncidentKey({ provider: "PLAID", plaidItemId: null, scope: { kind: "WALLET", id: "abc" }, domain: "transactions", stage: "s" });
    check("item / account / wallet with the SAME id are three distinct keys",
      new Set([asItem, asAcct, asWallet]).size === 3, [asItem, asAcct, asWallet].join(" | "));
    check("non-Plaid scopes are type-prefixed",
      asAcct.includes("FINANCIAL_ACCOUNT:abc") && asWallet.includes("WALLET:abc"));

    // BYTE-IDENTICAL to 5A-1: a Plaid item still serializes bare, so episodes
    // opened by the previous slice keep converging. This is why there is no
    // version bump — prefixing the item too would have orphaned live episodes.
    check("a Plaid key is byte-identical to the 5A-1 output",
      asItem === "v1::PLAID::abc::transactions::s", asItem);
    check("an unscoped key is explicit, not empty",
      buildIncidentKey({ provider: "PLAID", plaidItemId: null, scope: { kind: "LEGACY_UNSCOPED" }, domain: "transactions", stage: "s" })
        === "v1::PLAID::LEGACY_UNSCOPED::transactions::s");
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

  // ── 10. P8 #1 — a recovery is a TRANSITION with its proof ─────────────────
  //
  // Before this, AUTOMATIC_RECOVERY set `resolved` and the kind and nothing
  // else: no STATE_CHANGED event (the investigate timeline was silent for the
  // most common closure) and no resolutionEvidence (the row carried no proof).
  console.log("10. automatic recovery writes the STATE_CHANGED event and the evidence, in one CAS transaction");
  {
    const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
      const [e, l] = [console.error, console.log]; console.error = () => {}; console.log = () => {};
      try { return await f(); } finally { console.error = e; console.log = l; }
    };
    const stateChanges = (ev: Record<string, unknown>[], id: string) => ev.filter((e) => e.incidentId === id && e.type === "STATE_CHANGED");

    // ── transactions arm ──
    const t = makeClient([{ runId: "run-ok", id: "exec-ok" }]);
    const opened = await recordIncidentObservation(txFail("it1"), t.client);
    const r = await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions", runId: "run-ok" }, t.client, t.lookup));
    const row = t.issues.find((i) => i.id === opened!.incidentId)!;
    const ev = stateChanges(t.events, row.id);
    check("transactions: resolved, lifecycleState RESOLVED with `resolved`, reason TRANSACTIONS_SYNC_SUCCEEDED",
      r.resolved === 1 && row.resolved === true && row.lifecycleState === "RESOLVED" && row.resolutionReasonCode === "TRANSACTIONS_SYNC_SUCCEEDED");
    check("transactions: ONE SYSTEM STATE_CHANGED ACTIVE → RESOLVED, carrying the resolving execution",
      ev.length === 1 && ev[0].actorKind === "SYSTEM" && ev[0].actorId === null && ev[0].fromState === "ACTIVE"
      && ev[0].toState === "RESOLVED" && ev[0].refreshExecutionId === "exec-ok", JSON.stringify(ev));
    const txEv = row.resolutionEvidence as ResolutionEvidence;
    check("transactions: evidence is the SUCCEEDED TRANSACTIONS stage of the resolving execution",
      txEv?.rule === RECOVERY_RULE_TRANSACTIONS_SYNCED && txEv.proofCount === 1 && txEv.nonProof.length === 0
      && txEv.proof[0].source === "RefreshEndpointResult" && txEv.proof[0].endpoint === "TRANSACTIONS"
      && txEv.proof[0].status === "SUCCEEDED" && txEv.proof[0].executionId === "exec-ok" && mayAdvanceRecovery(txEv), JSON.stringify(txEv));
    check("transactions: evidence is identity-free (no item, transaction, detail or amount)",
      !/it1|tx1|transaction-persist|amount|plaid/i.test(JSON.stringify(txEv)), JSON.stringify(txEv));
    check("transactions: the stored evidence survives the typed reshaper unchanged (archive copy)",
      JSON.stringify(reshapeStoredEvidence(txEv)) === JSON.stringify(txEv));

    // Idempotent re-run: the closed row is not a candidate, so nothing more is written.
    const evBefore = t.events.length;
    const again = await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions", runId: "run-ok" }, t.client, t.lookup));
    check("idempotent: a re-run resolves nothing and writes no second event", again.resolved === 0 && t.events.length === evBefore);

    // No correlator: the fact still records the success, with a null execution — never invented.
    const t0 = makeClient();
    await recordIncidentObservation(txFail("it9"), t0.client);
    await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it9", domain: "transactions", runId: "run-orphan" }, t0.client, async () => null));
    const orphanEv = t0.issues[0].resolutionEvidence as ResolutionEvidence;
    check("no execution correlator: proof.executionId and the event's execution stay null",
      orphanEv?.proof[0]?.executionId === null && stateChanges(t0.events, t0.issues[0].id)[0]?.refreshExecutionId === null);

    // ── balances arm ──
    const b = makeClient([{ runId: "run-bal", id: "exec-bal" }]);
    const bal = await recordIncidentObservation(
      { kind: "BALANCE_UNOBSERVED", provider: "PLAID", financialAccountId: "fa-a", plaidAccountId: "p-fa-a", detail: { stage: "exchange-balance-unobserved" } },
      b.client);
    const rb = await quiet(() => resolveByAutomaticRecovery({ financialAccountId: "fa-a", domain: "balances", runId: "run-bal" }, b.client, b.lookup));
    const brow = b.issues.find((i) => i.id === bal!.incidentId)!;
    const bev = stateChanges(b.events, brow.id);
    const balEv = brow.resolutionEvidence as ResolutionEvidence;
    check("balances: resolved, lifecycleState RESOLVED, reason BALANCE_OBSERVED, one STATE_CHANGED → RESOLVED",
      rb.resolved === 1 && brow.lifecycleState === "RESOLVED" && brow.resolutionReasonCode === "BALANCE_OBSERVED" && bev.length === 1 && bev[0].toState === "RESOLVED" && bev[0].refreshExecutionId === "exec-bal");
    check("balances: evidence is the observed balance (BalanceObservation · BALANCES · SUCCEEDED)",
      balEv?.rule === RECOVERY_RULE_BALANCE_OBSERVED && balEv.proofCount === 1 && balEv.proof[0].source === "BalanceObservation"
      && balEv.proof[0].endpoint === "BALANCES" && balEv.proof[0].executionId === "exec-bal" && mayAdvanceRecovery(balEv), JSON.stringify(balEv));
    check("balances: evidence carries no account id and no amount", !/fa-a|p-fa-a|amount|balance"/i.test(JSON.stringify(balEv)), JSON.stringify(balEv));
    const digest = digestStoredEvidence(balEv);
    check("balances: the read-side digest accepts the new source (not dropped to null)",
      digest !== null && digest.rule === RECOVERY_RULE_BALANCE_OBSERVED && digest.proofCount === 1 && digest.mayAdvance === true);

    // ── the CAS loser writes nothing ──
    // A concurrent transition moves the row between the read and the write. The
    // CAS (lifecycleState as read, resolved=false) matches 0 rows, the
    // transaction throws and rolls back: no resolution, no evidence, no event —
    // and the shortfall is REPORTED, never counted as "nothing to do".
    const c = makeClient();
    const lost = await recordIncidentObservation(txFail("it1"), c.client);
    const raw = c.client as unknown as { syncIssue: { findMany: (a: unknown) => Promise<Record<string, unknown>[]> } };
    const realFind = raw.syncIssue.findMany;
    raw.syncIssue.findMany = async (a: unknown) => {
      const rows = await realFind(a);
      // the racing writer: an operator acknowledged it after our read
      const live = c.issues.find((i) => i.id === lost!.incidentId)!;
      live.lifecycleState = "ACKNOWLEDGED";
      return rows.map((x) => ({ ...x, lifecycleState: null }));
    };
    const reported: string[] = [];
    const evCount = c.events.length;
    const rc = await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, c.client, undefined, { onWriteFailure: (tb, ph) => reported.push(`${tb}:${ph}`) }));
    const lrow = c.issues.find((i) => i.id === lost!.incidentId)!;
    check("CAS loser: resolves nothing and writes NO event",
      rc.resolved === 0 && c.events.length === evCount && stateChanges(c.events, lrow.id).length === 0);
    check("CAS loser: the row keeps the winner's state, with no resolution fields or evidence",
      lrow.resolved === false && lrow.lifecycleState === "ACKNOWLEDGED" && lrow.resolutionKind == null && lrow.resolutionEvidence == null);
    check("CAS loser: the shortfall is reported as a resolution write failure (never silent)", reported.join() === "SyncIssue:resolution", reported.join());

    // ALL-OR-NOTHING: one row's lost CAS rolls back the whole call (no partial
    // count, no orphan event), is reported, and the next success proves the rest.
    const m = makeClient();
    const a1 = await recordIncidentObservation(txFail("it1"), m.client);
    const a2 = await recordIncidentObservation({ ...txFail("it1"), detail: { stage: "transaction-page-persist", cursorBlocking: true } }, m.client);
    const mraw = m.client as unknown as { syncIssue: { findMany: (a: unknown) => Promise<Record<string, unknown>[]> } };
    const mFind = mraw.syncIssue.findMany;
    let race = true;
    mraw.syncIssue.findMany = async (a: unknown) => {
      const rows = (await mFind(a)).map((x) => ({ ...x })); // what the resolver READ
      if (race) { race = false; m.issues.find((i) => i.id === a1!.incidentId)!.lifecycleState = "ACKNOWLEDGED"; }
      return rows;
    };
    const mReported: string[] = [];
    const mEvents = m.events.length;
    const rm = await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, m.client, undefined, { onWriteFailure: (tb, ph) => mReported.push(`${tb}:${ph}`) }));
    const live1 = () => m.issues.find((i) => i.id === a1!.incidentId)!;
    const live2 = () => m.issues.find((i) => i.id === a2!.incidentId)!;
    check("a lost CAS on one of two rows rolls back BOTH: 0 resolved, no event, reported",
      a1!.incidentId !== a2!.incidentId && rm.resolved === 0 && live1().resolved === false && live2().resolved === false
      && live2().resolutionEvidence == null && m.events.length === mEvents && mReported.join() === "SyncIssue:resolution",
      `${rm.resolved} / ${mReported}`);
    const rm2 = await quiet(() => resolveByAutomaticRecovery({ plaidItemId: "it1", domain: "transactions" }, m.client));
    check("…and the next success resolves both, ACKNOWLEDGED → RESOLVED recorded as such",
      rm2.resolved === 2 && live1().resolved && live2().resolved
      && stateChanges(m.events, a1!.incidentId)[0]?.fromState === "ACKNOWLEDGED"
      && stateChanges(m.events, a2!.incidentId)[0]?.fromState === "ACTIVE");
  }

  if (failures > 0) {
    console.error(`\nlifecycle.test: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log("\nlifecycle.test: all passed.");
}

main();
