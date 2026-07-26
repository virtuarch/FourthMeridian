/**
 * lib/plaid/sync-issue-isolation.test.ts
 *
 * PRE-V26-PLAID-CLOSE Phase 2B — proves unit tests can no longer write SyncIssue
 * rows into the developer's database (house pattern: standalone tsx, DB-free):
 *
 *   npx tsx lib/plaid/sync-issue-isolation.test.ts
 *
 * ── The bug this closes ──────────────────────────────────────────────────────
 * `recordSyncIssue` resolved `db` from module scope unconditionally, so it
 * escaped every caller's injected client. A unit test that passed a mocked client
 * and hit an error path wrote a REAL row into the dev Postgres — and because the
 * recorder swallows its own failures by design, nothing ever surfaced it. That is
 * the proven origin of the eight `stage: "opening-position-repair"` rows in the
 * local database, whose `financialAccountId` is the test fixture id `"fa1"`.
 *
 * Phase 2 gave `recordSyncIssue` an optional client (defaulting to the real `db`)
 * and threaded the already-injected client at every call site that has one.
 * Injection was chosen over a `NODE_ENV === "test"` no-op precisely so sync tests
 * can still ASSERT that an issue was recorded — see cursor-safety.test.ts, which
 * now observes UPSERT_ERROR / MISSING_ACCOUNT evidence through its fake.
 *
 * Behavioural only, by design. Earlier versions carried a source-scanning drift
 * guard (a paren-matching parser asserting the client was the last argument of
 * every call in a hand-listed set of files) plus pinned facade spellings. Those
 * pinned call shapes, went stale as producers changed, and duplicated what the
 * direct-write ban in incident-boundary.test.ts enforces durably. What this file
 * proves is the CONTRACT: the injected client receives every write, and a
 * failing recorder still never throws.
 */

import { recordSyncIssue } from "./syncIssues";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── 1. Behavioural — the injected client receives the write ──────────────────
console.log("1. recordSyncIssue writes through the INJECTED client");

async function behavioural(): Promise<void> {
  const written: Record<string, unknown>[] = [];
  // OPS-2D-5A-1 — recordSyncIssue is now a facade over the incident lifecycle,
  // so the injected client sees the episode write AND the occurrence write. The
  // ASSERTIONS are unchanged: what this file has always guarded is that the
  // caller's client is honoured and no bare `db.` escapes it — the leak that put
  // eight test rows in the developer database.
  const fake = {
    syncIssue: {
      create: async ({ data }: { data: Record<string, unknown> }) => { written.push(data); return { id: "si1" }; },
      findFirst: async () => null,
      update: async () => ({ id: "si1" }),
    },
    syncIssueOccurrence: { create: async () => ({ id: "so1" }) },
    // OPS-2D-TX-1 — `IncidentClient` requires `$transaction`, and a runtime
    // backstop REFUSES any client lacking it (a `Prisma.TransactionClient` has
    // it removed by ITXClientDenyList). Declaring the stub is how a fake says
    // "I stand in for a ROOT client". It throws if anything ever calls it,
    // because the lifecycle must not open a transaction of its own.
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
  };

  await recordSyncIssue(
    { kind: "UPSERT_ERROR", plaidTransactionId: "txn_1", detail: { stage: "unit-test" } },
    fake as never,
  );
  check("the fake captured the write", written.length === 1, `${written.length}`);
  check("payload is intact", written[0]?.kind === "UPSERT_ERROR" && written[0]?.plaidTransactionId === "txn_1");

  // Still never throws — the contract that makes it safe inside a catch block.
  const exploding = {
    syncIssue: { create: async () => { throw new Error("boom"); }, findFirst: async () => null },
    syncIssueOccurrence: { create: async () => { throw new Error("boom"); } },
    // Also a ROOT-client stand-in: without this the backstop would REFUSE the
    // write before reaching `create`, and this case would prove the refusal path
    // rather than the "a failing recorder still never throws" contract it exists
    // to guard.
    $transaction: async () => { throw new Error("the incident lifecycle must not open transactions"); },
  };
  let threw = false;
  try { await recordSyncIssue({ kind: "UPSERT_ERROR" }, exploding as never); } catch { threw = true; }
  check("a failing recorder still never throws (contract preserved)", !threw);
}

void behavioural().then(() => {
  console.log(failures === 0
    ? "\n✅ sync-issue isolation: all checks passed"
    : `\n❌ sync-issue isolation: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
});
