/**
 * lib/investments/event-coverage-write.test.ts
 *
 * V26-QUANTITY-1E′ — the INGEST-PATH write. Standalone tsx script:
 *
 *     npx tsx lib/investments/event-coverage-write.test.ts
 *
 * No database and no provider: the Plaid client is stubbed on
 * `PlaidApi.prototype` (the lazy proxy cannot be replaced), and a recording
 * stub stands in for Prisma. What is under test is the one property the arc
 * depends on — that EVERY outcome, including the ones that return early, leaves
 * a written record of what was asked for.
 */

import { PlaidApi } from "plaid";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

interface CoverageRow {
  attemptId: string; plaidItemId: string; financialAccountId: string;
  requestedFromDate: Date; requestedToDate: Date; outcome: string;
  reportedTotal: number | null; fetchedCount: number; pagesFetched: number;
  detail: string | null; attemptedAt: Date;
}

/** Records coverage writes; every other model is a no-op that returns nothing. */
function stubClient() {
  const rows: CoverageRow[] = [];
  const none = async () => null;
  const noneMany = async () => [];
  const model = {
    findFirst: none, findUnique: none, findMany: noneMany,
    create: async () => ({ id: "x" }), update: async () => ({ id: "x" }),
    upsert: async () => ({ id: "x" }), count: async () => 0,
    createMany: async () => ({ count: 0 }), groupBy: noneMany, aggregate: async () => ({}),
  };
  return {
    rows,
    client: new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "investmentEventCoverage") {
          return { ...model, createMany: async (args: { data: CoverageRow[] }) => {
            rows.push(...args.data); return { count: args.data.length };
          } };
        }
        if (prop === "$transaction") return async (fn: (c: unknown) => unknown) => fn(model);
        return model;
      },
    }) as never,
  };
}

/** Replace the paginated fetch with a scripted response or a thrown error. */
function stubPlaid(behaviour:
  | { kind: "pages"; total: number; pages: number[][] }
  | { kind: "throw"; code: string }) {
  let call = 0;
  (PlaidApi.prototype as unknown as Record<string, unknown>).investmentsTransactionsGet =
    async () => {
      if (behaviour.kind === "throw") {
        const err = new Error("stub") as Error & { response?: { data?: { error_code?: string } } };
        err.response = { data: { error_code: behaviour.code } };
        throw err;
      }
      const page = behaviour.pages[call++] ?? [];
      return { data: {
        total_investment_transactions: behaviour.total,
        investment_transactions: page.map((i) => ({
          investment_transaction_id: `itx_${i}`, account_id: "plaid_acct_1",
          security_id: null, date: "2026-05-01", name: "stub", quantity: 1,
          amount: -100, price: 100, fees: 0, type: "buy", subtype: "buy",
          iso_currency_code: "USD", unofficial_currency_code: null,
        })),
        securities: [],
      } };
    };
}

async function main(): Promise<void> {
  // Placeholder credentials so the Plaid client module passes its load-time env
  // check. It is never called: `investmentsTransactionsGet` is stubbed below, so
  // no request is ever built and no real value is needed.
  process.env.PLAID_CLIENT_ID ??= "test-client-id";
  process.env.PLAID_SECRET ??= "test-secret";
  process.env.PLAID_ENV ??= "sandbox";
  process.env.INVESTMENT_EVENTS_ENABLED = "true";
  process.env.INVESTMENT_RECONSTRUCTION_ENABLED = "false";
  process.env.SECURITY_PRICES_ENABLED = "false";
  const { ingestInvestmentEvents, recordDisabledInvestmentEventCoverage } =
    await import("./investment-event-ingest");

  const run = async (
    behaviour: Parameters<typeof stubPlaid>[0],
    covered = ["fa_1", "fa_2"],
  ): Promise<CoverageRow[]> => {
    const { rows, client } = stubClient();
    stubPlaid(behaviour);
    await ingestInvestmentEvents({
      accessToken: "stub-token", plaidItemId: "item_1",
      now: new Date("2026-07-31T00:00:00Z"),
      coveredFinancialAccountIds: covered, client,
    });
    return rows;
  };

  console.log("1. a fully reconciled window is COMPLETE");
  {
    const rows = await run({ kind: "pages", total: 2, pages: [[1, 2]] });
    check("one row per covered account", rows.length === 2);
    check("…sharing one attemptId", new Set(rows.map((r) => r.attemptId)).size === 1);
    check("…outcome COMPLETE", rows.every((r) => r.outcome === "COMPLETE"));
    check("…recording the 24-month window that was ASKED FOR",
      rows[0].requestedFromDate.toISOString().slice(0, 10) === "2024-07-31" &&
      rows[0].requestedToDate.toISOString().slice(0, 10) === "2026-07-31");
    check("…with the provider's reported total and what arrived",
      rows[0].reportedTotal === 2 && rows[0].fetchedCount === 2 && rows[0].pagesFetched === 1);
    check("…and no detail, because nothing needs explaining", rows[0].detail === null);
  }

  console.log("2. an EMPTY window still reconciles — the load-bearing case");
  {
    const rows = await run({ kind: "pages", total: 0, pages: [[]] });
    check("zero transactions with zero reported → COMPLETE, not PARTIAL",
      rows.length === 2 && rows.every((r) => r.outcome === "COMPLETE"));
    check("…fetchedCount 0 is what makes 'no events' mean 'no movement'",
      rows[0].fetchedCount === 0 && rows[0].reportedTotal === 0);
  }

  console.log("3. a short stream is PARTIAL, never COMPLETE");
  {
    // The provider claims 5 but the page runs dry at 2.
    const rows = await run({ kind: "pages", total: 5, pages: [[1, 2], []] });
    check("a page running dry below the reported total → PARTIAL",
      rows.every((r) => r.outcome === "PARTIAL"));
    check("…stating the shortfall in the detail",
      /reported 5, received 2/.test(rows[0].detail ?? ""));
    check("…and this is the case the old break condition silently accepted",
      rows[0].reportedTotal === 5 && rows[0].fetchedCount === 2);
  }

  console.log("4. every early return still records");
  {
    const failed = await run({ kind: "throw", code: "INTERNAL_SERVER_ERROR" });
    check("a fetch failure records FAILED", failed.length === 2 && failed.every((r) => r.outcome === "FAILED"));
    check("…rather than leaving the window silent", failed[0].requestedToDate instanceof Date);

    const consent = await run({ kind: "throw", code: "ADDITIONAL_CONSENT_REQUIRED" });
    check("a consent refusal records CONSENT_REQUIRED",
      consent.every((r) => r.outcome === "CONSENT_REQUIRED"));

    const notReady = await run({ kind: "throw", code: "PRODUCT_NOT_READY" });
    check("PRODUCT_NOT_READY records NOT_READY", notReady.every((r) => r.outcome === "NOT_READY"));

    const { rows, client } = stubClient();
    await recordDisabledInvestmentEventCoverage({
      plaidItemId: "item_1", coveredFinancialAccountIds: ["fa_1"],
      now: new Date("2026-07-31T00:00:00Z"), client,
    });
    check("the kill switch being off records DISABLED",
      rows.length === 1 && rows[0].outcome === "DISABLED");
    check("…so a flag-off period cannot masquerade as a quiet one",
      /INVESTMENT_EVENTS_ENABLED/.test(rows[0].detail ?? ""));
  }

  console.log("5. nothing is recorded when nothing can be claimed");
  {
    const noAccounts = await run({ kind: "pages", total: 0, pages: [[]] }, []);
    check("no covered accounts → no rows, rather than an unattributable claim",
      noAccounts.length === 0);

    const { rows, client } = stubClient();
    stubPlaid({ kind: "pages", total: 0, pages: [[]] });
    await ingestInvestmentEvents({
      accessToken: "stub", now: new Date("2026-07-31T00:00:00Z"),
      coveredFinancialAccountIds: ["fa_1"], client,
    });
    check("no plaidItemId → no rows (coverage must attach to an item)", rows.length === 0);
  }

  console.log("6. the write is append-only and deterministic");
  {
    const a = await run({ kind: "pages", total: 2, pages: [[1, 2]] });
    const b = await run({ kind: "pages", total: 2, pages: [[1, 2]] });
    const strip = (rows: CoverageRow[]) => rows.map(({ attemptId, ...r }) => { void attemptId; return r; });
    check("identical input yields identical rows apart from the attempt id",
      JSON.stringify(strip(a)) === JSON.stringify(strip(b)));
    check("…and the attempt ids differ, so attempts are never conflated",
      a[0].attemptId !== b[0].attemptId);
    check("accounts are written in sorted order",
      a.map((r) => r.financialAccountId).join() === ["fa_1", "fa_2"].join());
  }

  console.log(failures === 0 ? "\nAll coverage-write checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
