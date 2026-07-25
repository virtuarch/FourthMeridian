/**
 * scripts/test-incident-transaction-safety.ts   (OPS-2D-TX-1)
 *
 * DB harness (NOT a unit test — needs a live Postgres, so it is named
 * `test-*.ts` and excluded from `npm run test:unit`, per scripts/run-tests.ts).
 *
 *     docker run -d --name ops2dtx1-db -e POSTGRES_PASSWORD=tx1 \
 *       -e POSTGRES_USER=tx1 -e POSTGRES_DB=tx1 \
 *       -p 127.0.0.1:55432:5432 postgres:16-alpine
 *     DATABASE_URL=postgresql://tx1:tx1@127.0.0.1:55432/tx1 \
 *     DIRECT_URL=postgresql://tx1:tx1@127.0.0.1:55432/tx1 npx prisma migrate deploy
 *     TX1_DATABASE_URL=postgresql://tx1:tx1@127.0.0.1:55432/tx1 \
 *       npx tsx --require ./scripts/lib/server-only-preload.cjs \
 *       scripts/test-incident-transaction-safety.ts
 *
 * A DISPOSABLE database is mandatory, and its URL must be passed explicitly in
 * TX1_DATABASE_URL — this file never reads .env.local, so it cannot be pointed
 * at the development database by accident. It writes and truncates freely.
 *
 * ── WHY A FAKE CANNOT CLOSE THIS SLICE ───────────────────────────────────────
 * The defect is a PostgreSQL transaction-state behaviour (SQLSTATE 25P02) that
 * only a real engine exhibits, reached through a real partial unique index under
 * real concurrency. An in-memory client can model the constraint; it cannot
 * model what the constraint does to the surrounding transaction.
 *
 * The defect, reproduced in NV below: an incident recorded through a CALLER'S
 * transaction client that loses the convergence race raises P2002, which aborts
 * the caller's transaction. Every later statement then fails, the lifecycle's
 * outer catch swallows the evidence, and COMMIT silently degrades to ROLLBACK —
 * so the financial writes vanish while the caller is told it succeeded.
 *
 * The races are made DETERMINISTIC without touching production code: a second
 * writer INSERTs the winning episode inside its own uncommitted transaction. In
 * READ COMMITTED that row is invisible to the lifecycle's find-active query, but
 * the lifecycle's INSERT blocks on the unique index until the other writer
 * commits — and then raises P2002. That is the production interleaving, forced.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { recordIncidentObservation, resolveByAutomaticRecovery, type IncidentClient } from "@/lib/platform/incidents/lifecycle";
import { buildIncidentKey } from "@/lib/platform/incidents/identity";

const URL = process.env.TX1_DATABASE_URL;
if (!URL) throw new Error("TX1_DATABASE_URL is required — point it at a DISPOSABLE database.");
if (/localhost:5432|@db\.|supabase|pooler/.test(URL)) {
  throw new Error(`refusing to run against what looks like a real database: ${URL.replace(/:[^:@]*@/, ":***@")}`);
}

const db = new PrismaClient({ datasources: { db: { url: URL } } });
const other = new PrismaClient({ datasources: { db: { url: URL } } });

let failures = 0;
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

const defer = () => {
  let resolve!: () => void;
  return { p: new Promise<void>((r) => (resolve = r)), resolve: () => resolve() };
};

/**
 * Prisma prefixes its errors with the offending query text, so the SQLSTATE we
 * care about sits at the END. Keep the tail, not the head — truncating from the
 * front throws away the only part that identifies the failure.
 */
const msg = (e: unknown) => {
  const full = String((e as { message?: string })?.message ?? e).replace(/\s+/g, " ");
  return full.length > 260 ? `… ${full.slice(-260)}` : full;
};
/** SQLSTATE 25P02 — "current transaction is aborted". */
const isAborted = (s: string | null) => !!s && s.includes("25P02");

let ACCOUNT = "";
const ITEM = "tx1-item";

/** Reset every table this harness touches, between scenarios. */
async function reset() {
  await db.syncIssueOccurrence.deleteMany({});
  await db.syncIssue.deleteMany({});
  await db.transaction.deleteMany({});
}

async function fixtures() {
  const user = await db.user.upsert({
    where: { email: "tx1@disposable.local" }, update: {},
    create: { email: "tx1@disposable.local", name: "TX1" }, select: { id: true },
  });
  const acct = await db.financialAccount.create({
    data: {
      name: "__tx1_acct__", type: "checking", institution: "Disposable",
      ownerType: "USER", ownerUserId: user.id, createdByUserId: user.id,
      balance: 0, currency: "USD",
    },
    select: { id: true },
  });
  ACCOUNT = acct.id;
}

/** A financial write — the mutation incident telemetry must never endanger. */
const financialWrite = (client: Prisma.TransactionClient | PrismaClient, merchant: string, amount: number) =>
  client.transaction.create({
    data: { financialAccountId: ACCOUNT, date: new Date("2026-03-01"), merchant, category: "Other", amount },
  });

/** The account-scoped investment-repair observation used throughout. */
const OBS = () => ({
  kind: "INVESTMENT_DATA_PERSISTENCE_FAILED" as const,
  financialAccountId: ACCOUNT,
  detail: { stage: "investment-import-repair", error: "disposable" } as Prisma.InputJsonValue,
});
const KEY = () => buildIncidentKey({
  provider: "PLAID", plaidItemId: null,
  scope: { kind: "FINANCIAL_ACCOUNT", id: ACCOUNT },
  domain: "investments", stage: "investment-import-repair",
});

/** Seed the winning episode from a second connection, held uncommitted. */
function raceWinner(incidentKey: string, release: Promise<void>) {
  const inserted = defer();
  const done = other.$transaction(async (wtx) => {
    await wtx.syncIssue.create({
      data: {
        provider: "PLAID", financialAccountId: ACCOUNT,
        kind: "INVESTMENT_DATA_PERSISTENCE_FAILED",
        detail: OBS().detail, incidentKey, incidentKeyVersion: 1, resolved: false,
        firstOccurredAt: new Date(), lastOccurredAt: new Date(),
      },
    });
    inserted.resolve();
    await release;
  }, { timeout: 30000 });
  return { inserted: inserted.p, done };
}

// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  await fixtures();

  // ── NV — NON-VACUITY: the defect this slice removes, reproduced verbatim ────
  //
  // This replays the PRE-FIX lifecycle sequence inline (create → P2002 → retry
  // the find on the SAME transaction client). It deliberately does NOT call
  // recordIncidentObservation, because the fix now refuses that client — which
  // is precisely why this probe is needed: it proves the harness can still SEE
  // the failure mode, so the green checks below mean something.
  console.log("\nNV. NON-VACUITY — the pre-fix sequence still poisons a caller transaction");
  await reset();
  {
    const release = defer();
    const winner = raceWinner(KEY(), release.p);
    await winner.inserted;

    const seen = { p2002: false, retryError: null as string | null, laterWriteError: null as string | null, commitError: null as string | null };
    try {
      await db.$transaction(async (tx) => {
        await financialWrite(tx, "NV_ROW_A", -1);
        // The pre-fix convergence, identical in shape to what lifecycle.ts did.
        const create = tx.syncIssue.create({
          data: {
            provider: "PLAID", financialAccountId: ACCOUNT,
            kind: "INVESTMENT_DATA_PERSISTENCE_FAILED",
            detail: OBS().detail, incidentKey: KEY(), incidentKeyVersion: 1, resolved: false,
            firstOccurredAt: new Date(), lastOccurredAt: new Date(),
          },
        });
        setTimeout(release.resolve, 1200);
        try { await create; } catch (e) {
          seen.p2002 = (e as { code?: string }).code === "P2002";
          try { await tx.syncIssue.findFirst({ where: { incidentKey: KEY(), resolved: false } }); }
          catch (r) { seen.retryError = msg(r); }
        }
        try { await financialWrite(tx, "NV_ROW_B", -2); } catch (e) { seen.laterWriteError = msg(e); }
      }, { timeout: 30000 });
    } catch (e) { seen.commitError = msg(e); }
    release.resolve(); await winner.done;

    check("the losing writer receives P2002", seen.p2002);
    check("the convergence retry then fails with 25P02 (transaction aborted)", isAborted(seen.retryError), seen.retryError ?? "no error");
    check("a later business write in the same transaction fails", isAborted(seen.laterWriteError), seen.laterWriteError ?? "no error");
    check("COMMIT reports success anyway — the silence that hides the loss", seen.commitError === null, seen.commitError ?? "");
    const lost = await db.transaction.count({ where: { merchant: { startsWith: "NV_ROW_" } } });
    check("BOTH financial rows were destroyed — the defect is real and detectable", lost === 0, `${lost} row(s) survived`);
  }

  // ── E1 — BUSINESS SURVIVAL: the same race, through the fixed lifecycle ──────
  console.log("\nE1. BUSINESS SURVIVAL — a transaction client can no longer endanger the mutation");
  await reset();
  {
    const release = defer();
    const winner = raceWinner(KEY(), release.p);
    await winner.inserted;

    let result: unknown = "unset";
    let commitError: string | null = null;
    try {
      await db.$transaction(async (tx) => {
        await financialWrite(tx, "E1_ROW_A", -10);
        // The compile-time contract forbids this; the cast is what a stray `any`
        // or a JavaScript caller would produce, and is the ONLY way to reach the
        // runtime backstop. Nothing in the product tree can express it.
        result = await recordIncidentObservation(OBS(), tx as unknown as IncidentClient, async () => null);
        await financialWrite(tx, "E1_ROW_B", -20);
      }, { timeout: 30000 });
    } catch (e) { commitError = msg(e); }
    release.resolve(); await winner.done;

    check("the lifecycle refuses the transaction client (returns null, never throws)", result === null, String(result));
    check("the caller's transaction commits normally", commitError === null, commitError ?? "");
    check("BUSINESS ROW A persisted", (await db.transaction.count({ where: { merchant: "E1_ROW_A" } })) === 1);
    check("BUSINESS ROW B persisted", (await db.transaction.count({ where: { merchant: "E1_ROW_B" } })) === 1);
    check("the refusal left no partial incident row",
      (await db.syncIssue.count({ where: { financialAccountId: ACCOUNT } })) === 1, "only the race winner should exist");
  }

  // ── E2 — CONVERGENCE: the same race, recorded the SUPPORTED way ─────────────
  //
  // A root client is not inside the caller's transaction, so P2002 lands on an
  // autocommit statement: the retry succeeds and joins the winner's episode.
  console.log("\nE2. CONVERGENCE — a root client loses the race and joins the winning episode");
  await reset();
  {
    const release = defer();
    const winner = raceWinner(KEY(), release.p);
    await winner.inserted;
    setTimeout(release.resolve, 1200);

    const r = await recordIncidentObservation(OBS(), db, async () => null);
    await winner.done;

    const active = await db.syncIssue.findMany({ where: { incidentKey: KEY(), resolved: false }, select: { id: true } });
    check("the observation was recorded", r !== null);
    check("it JOINED rather than opening a second episode", r?.created === false, JSON.stringify(r));
    check("exactly ONE active episode for the identity", active.length === 1, `${active.length}`);
    check("the joined episode is the race winner", r?.incidentId === active[0]?.id);
    check("its occurrence was appended exactly once",
      (await db.syncIssueOccurrence.count({ where: { syncIssueId: active[0]?.id } })) === 1);
  }

  // ── E3 — FAILURE ISOLATION: a NON-P2002 telemetry failure ──────────────────
  console.log("\nE3. FAILURE ISOLATION — a non-P2002 telemetry failure cannot reach the caller");
  await reset();
  {
    // A root client whose occurrence write always fails: the episode is created,
    // then persistence breaks for a reason the P2002 path never sees.
    const broken = Object.create(db) as IncidentClient;
    Object.defineProperty(broken, "syncIssueOccurrence", {
      value: { create: async () => { throw new Error("occurrence store unavailable"); } },
    });

    let threw = false, commitError: string | null = null, result: unknown = "unset";
    try {
      await db.$transaction(async (tx) => {
        await financialWrite(tx, "E3_ROW_A", -30);
        try { result = await recordIncidentObservation(OBS(), broken, async () => null); }
        catch { threw = true; }
        await financialWrite(tx, "E3_ROW_B", -40);
      }, { timeout: 30000 });
    } catch (e) { commitError = msg(e); }

    check("the failure never propagates to the producer", !threw);
    check("it is reported as a failure, not a silent success", result === null, String(result));
    check("the caller's transaction still commits", commitError === null, commitError ?? "");
    check("both financial rows persisted",
      (await db.transaction.count({ where: { merchant: { startsWith: "E3_ROW_" } } })) === 2);
    check("no orphan occurrence was left", (await db.syncIssueOccurrence.count({})) === 0);
  }

  // ── E4 — ROLLBACK HONESTY ──────────────────────────────────────────────────
  //
  // The incident is written on its own connection, so it SURVIVES a rollback of
  // the surrounding mutation. That is correct here, and must stay explicit:
  // every production incident records an operation that was ATTEMPTED AND
  // FAILED (a repair that threw, a fetch that errored, a row that would not
  // persist). None claims a mutation committed, so none is falsified by the
  // rollback — and the failure genuinely happened, so erasing it would be the
  // dishonest outcome, not the safe one.
  console.log("\nE4. ROLLBACK HONESTY — the incident describes an attempted operation, not a committed one");
  await reset();
  {
    try {
      await db.$transaction(async (tx) => {
        await financialWrite(tx, "E4_ROW_A", -50);
        await recordIncidentObservation(OBS(), db, async () => null);
        throw new Error("business rollback");
      }, { timeout: 30000 });
    } catch { /* expected */ }

    const ep = await db.syncIssue.findFirst({ where: { incidentKey: KEY() }, select: { id: true, resolved: true } });
    check("the financial mutation rolled back",
      (await db.transaction.count({ where: { merchant: "E4_ROW_A" } })) === 0);
    check("the incident survives — the failure it records really did happen", ep !== null);
    check("it is an OPEN condition, claiming nothing about committed state", ep?.resolved === false);
    const occ = await db.syncIssueOccurrence.findFirst({ where: { syncIssueId: ep?.id }, select: { detail: true } });
    check("its occurrence stores only the observation, never a business outcome",
      occ !== null && !/committed|persisted|rolledBack/i.test(JSON.stringify(occ?.detail ?? {})));
  }

  // ── E5 — NORMAL CALLER REGRESSION ──────────────────────────────────────────
  console.log("\nE5. NORMAL CALLERS — create · append · converge · correlate");
  await reset();
  {
    const first = await recordIncidentObservation(OBS(), db, async () => null);
    const second = await recordIncidentObservation(OBS(), db, async () => null);
    check("the first observation opens an episode", first?.created === true);
    check("the second joins it", second?.created === false && second?.incidentId === first?.incidentId);
    check("still exactly one active episode",
      (await db.syncIssue.count({ where: { incidentKey: KEY(), resolved: false } })) === 1);
    check("two occurrences recorded",
      (await db.syncIssueOccurrence.count({ where: { syncIssueId: first?.incidentId } })) === 2);

    // Execution correlation stays a LOOKUP: a correlator naming no execution
    // must store null rather than fabricate an FK.
    const withRun = await recordIncidentObservation(
      { ...OBS(), plaidItemId: ITEM, runId: "run-known" }, db,
      async (runId) => (runId === "run-known" ? "exec-1" : null),
    );
    check("a resolvable correlator stores the execution FK", withRun?.refreshExecutionId === "exec-1");
    const orphan = await recordIncidentObservation(
      { ...OBS(), plaidItemId: "tx1-item-2", runId: "run-orphan" }, db, async () => null,
    );
    check("an unresolvable correlator stores null, never a fabricated FK", orphan?.refreshExecutionId === null);
  }

  // ── E6 — RESOLVER REGRESSION ───────────────────────────────────────────────
  console.log("\nE6. RESOLVER — automatic recovery still resolves, and only what it proves");
  await reset();
  let resolvedEpisodeId = "";
  {
    const blocking = await recordIncidentObservation({
      kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: ITEM, plaidTransactionId: "t1",
      detail: { stage: "transaction-persist", cursorBlocking: true },
    }, db, async () => null);
    // Same item, but an investments condition — a transaction sync succeeding
    // proves nothing about it, so it must NOT be resolved.
    const unrelated = await recordIncidentObservation({
      kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", plaidItemId: ITEM,
      detail: { stage: "investment-import-repair" },
    }, db, async () => null);

    const { resolved } = await resolveByAutomaticRecovery(
      { plaidItemId: ITEM, domain: "transactions", runId: null }, db, async () => null,
    );
    check("the cursor-blocking transaction condition resolved", resolved === 1, `${resolved}`);
    const b = await db.syncIssue.findUnique({ where: { id: blocking!.incidentId }, select: { resolved: true, resolvedAt: true, resolutionKind: true } });
    check("it carries a resolution timestamp and kind",
      b?.resolved === true && b?.resolvedAt !== null && b?.resolutionKind === "AUTOMATIC_RECOVERY");
    const u = await db.syncIssue.findUnique({ where: { id: unrelated!.incidentId }, select: { resolved: true } });
    check("the unrelated investments condition stays OPEN", u?.resolved === false);
    resolvedEpisodeId = blocking!.incidentId;
  }

  // ── E7 — RECURRENCE REGRESSION ─────────────────────────────────────────────
  console.log("\nE7. RECURRENCE — a resolved episode recurs as a NEW generation, linked backwards");
  {
    const again = await recordIncidentObservation({
      kind: "TRANSACTION_PERSISTENCE_FAILED", plaidItemId: ITEM, plaidTransactionId: "t2",
      detail: { stage: "transaction-persist", cursorBlocking: true },
    }, db, async () => null);
    check("a new episode is opened, not the resolved one reused",
      again?.created === true && again?.incidentId !== resolvedEpisodeId);
    const row = await db.syncIssue.findUnique({ where: { id: again!.incidentId }, select: { previousIncidentId: true } });
    check("it links back to the previous generation via previousIncidentId",
      row?.previousIncidentId === resolvedEpisodeId, `${row?.previousIncidentId}`);
  }

  console.log(failures === 0
    ? "\nAll incident transaction-safety checks passed."
    : `\n${failures} check(s) FAILED`);
  await db.$disconnect(); await other.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect(); await other.$disconnect();
  process.exit(1);
});
