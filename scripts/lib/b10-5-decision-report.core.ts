/**
 * scripts/lib/b10-5-decision-report.core.ts — the READ-ONLY counts behind the
 * four B10.5 owner data decisions (docs/plans/PRE-BETA-READINESS-AND-RELEASE-PLAN-2026-11-01.md
 * § "B10.5 Owner-gated data decisions"). Driven by scripts/b10-5-decision-report.ts.
 *
 *   coingecko   FM-AUDIT-025  archived CoinGecko closes filed one day late
 *   fin-a2      FIN-A2        Plaid accounts holding a $0 that was probably never observed
 *   fin-e       FIN-E         snapshot days a regeneration would give a restrictedCash
 *   audit-021   FM-AUDIT-021  frozen "observed" days that rested on a stale bank balance
 *   frozen-restricted  FIN-E     frozen observed NULL-restrictedCash days whose split a walk-back could derive
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 *   · READ ONLY. Every report runs in ONE transaction whose first statement is
 *     `SET TRANSACTION READ ONLY` (transaction-scoped; never a session SET — the
 *     2026-10-25 pooler incident). There is no write path in this module.
 *   · COUNTS AND DATE RANGES ONLY. No row id, amount, name, email or institution
 *     ever leaves a query: the SQL aggregates, and the only label printed is a
 *     coin ticker, sanitised to [A-Z0-9]{1,10} (anything else prints as "other").
 *   · NEVER GUESS. When a column a report needs is absent from the target (a
 *     migration not yet applied there), that report is UNAVAILABLE with the
 *     missing column named; it is not computed from a substitute.
 *   · Every heuristic is printed beside its numbers. The numbers are candidate
 *     counts for a decision, not a repair plan.
 */

export const REPORTS = ["coingecko", "fin-a2", "fin-e", "audit-021", "frozen-restricted"] as const;
export type ReportName = (typeof REPORTS)[number];

/** CoinGecko returns DAILY (00:00Z) points for a market_chart/range request longer than 90 days. */
export const COINGECKO_HOURLY_MAX_DAYS = 90;
/**
 * A stored batch spanning MORE than this many calendar days (inclusive) can only
 * have come from a request longer than 90 days ⇒ daily granularity ⇒ every row
 * sits on a 00:00Z point. One day of margin over 90 keeps the boundary case out.
 */
export const COINGECKO_DEFINITE_DAILY_MIN_SPAN = COINGECKO_HOURLY_MAX_DAYS + 2;
/** lib/freshness/observation.ts STALE_AFTER_DAYS — the stale-bank horizon FM-AUDIT-021 (#302) uses. */
export const STALE_AFTER_DAYS = 7;

/**
 * The depository subtypes `liquidityAccess` (lib/account-classifier.ts) calls
 * "restricted": the only accounts whose balance enters `classifyAccounts
 * .totalRestrictedCash`, i.e. `SpaceSnapshot.restrictedCash`. Restricted
 * INVESTMENT subtypes (401k, IRA, …) never enter that column: it splits
 * checking + savings only. Mirrored, not imported (the classifier pulls the FX
 * stack); pinned equal to the classifier's set by the unit test.
 */
export const RESTRICTED_DEPOSITORY_SUBTYPES: readonly string[] = ["hsa"];

/** The schema facts each report reads. Missing any ⇒ UNAVAILABLE. */
export const REQUIRED_COLUMNS: Record<ReportName, ReadonlyArray<readonly [table: string, column: string]>> = {
  coingecko: [
    ["PriceObservation", "instrumentId"], ["PriceObservation", "date"], ["PriceObservation", "basis"],
    ["PriceObservation", "source"], ["PriceObservation", "fetchedAt"], ["Instrument", "tickerSymbol"],
  ],
  "fin-a2": [
    ["FinancialAccount", "plaidAccountId"], ["FinancialAccount", "deletedAt"], ["FinancialAccount", "balance"],
    ["FinancialAccount", "balanceObserved"], ["FinancialAccount", "createdAt"], ["FinancialAccount", "type"],
    ["FinancialAccount", "balanceLastUpdatedAt"],
    ["RefreshEndpointAccountCoverage", "financialAccountId"], ["RefreshEndpointAccountCoverage", "endpoint"],
    ["RefreshEndpointAccountCoverage", "status"], ["RefreshEndpointAccountCoverage", "freshnessAdvanced"],
    ["RefreshEndpointAccountCoverage", "createdAt"],
  ],
  "fin-e": [
    ["SpaceSnapshot", "restrictedCash"], ["SpaceSnapshot", "isEstimated"], ["SpaceSnapshot", "spaceId"], ["SpaceSnapshot", "date"],
    ["SpaceAccountLink", "spaceId"], ["SpaceAccountLink", "financialAccountId"], ["SpaceAccountLink", "status"],
    ["FinancialAccount", "deletedAt"],
  ],
  "audit-021": [
    ["SpaceSnapshot", "isEstimated"], ["SpaceSnapshot", "spaceId"], ["SpaceSnapshot", "date"],
    ["SpaceAccountLink", "spaceId"], ["SpaceAccountLink", "financialAccountId"], ["SpaceAccountLink", "createdAt"], ["SpaceAccountLink", "revokedAt"],
    ["FinancialAccount", "type"], ["FinancialAccount", "syncStatus"], ["FinancialAccount", "plaidAccountId"],
    ["FinancialAccount", "createdAt"], ["FinancialAccount", "deletedAt"],
    ["RefreshEndpointAccountCoverage", "financialAccountId"], ["RefreshEndpointAccountCoverage", "endpoint"],
    ["RefreshEndpointAccountCoverage", "status"], ["RefreshEndpointAccountCoverage", "freshnessAdvanced"],
    ["RefreshEndpointAccountCoverage", "createdAt"],
  ],
  "frozen-restricted": [
    ["SpaceSnapshot", "restrictedCash"], ["SpaceSnapshot", "isEstimated"], ["SpaceSnapshot", "spaceId"], ["SpaceSnapshot", "date"],
    ["SpaceAccountLink", "spaceId"], ["SpaceAccountLink", "financialAccountId"], ["SpaceAccountLink", "createdAt"], ["SpaceAccountLink", "revokedAt"],
    ["FinancialAccount", "type"], ["FinancialAccount", "providerSubtype"], ["FinancialAccount", "createdAt"], ["FinancialAccount", "deletedAt"],
    ["Transaction", "financialAccountId"], ["Transaction", "date"], ["Transaction", "pending"], ["Transaction", "deletedAt"],
  ],
};

export const HEURISTICS: Record<ReportName, string> = {
  coingecko:
    "The archive keeps no provider timestamp, so a row's granularity is inferred from its insert batch: rows of one coin with the same `source` and the same `fetchedAt` were written by one INSERT, i.e. one CoinGecko response. " +
    `CoinGecko returns daily points stamped 00:00Z for a range longer than ${COINGECKO_HOURLY_MAX_DAYS} days, and the pre-#300 parser filed each under the wrong (next) day. ` +
    `A batch spanning ${COINGECKO_DEFINITE_DAILY_MIN_SPAN}+ calendar days can only come from such a request, so its rows are counted as one day late (a lower bound). ` +
    "Shorter batches may be hourly (correct) or a daily response trimmed by skip-duplicates; they are counted as undetermined. Batches fetched on or after `--coingecko-fixed-from` (the #300 deploy date on that environment) are excluded when the flag is given.",
  "fin-a2":
    "No column records where an account's first balance came from, so the Plaid balance ledger stands in for it. A candidate is a live Plaid account (`plaidAccountId` set, not deleted) with `balance = 0` and `balanceObserved = true` " +
    "that has NO `RefreshEndpointAccountCoverage` row for BALANCES with status COVERED and `freshnessAdvanced = true` since it was created: its only balance write was the token exchange. " +
    "Accounts created before the ledger's first BALANCES row are counted separately (the ledger cannot see their earlier refreshes). Before FIN-011 a refresh could mark a null balance as advanced, so the count is a lower bound for that period; a real $0 (a paid-off card) also qualifies, so these are review candidates, not confirmed defects.",
  "fin-e":
    "A row is fillable when `restrictedCash` IS NULL, it is an estimate (`isEstimated = true`, which the automatic regeneration may rewrite), and its Space has at least one ACTIVE account link to a non-deleted account (the inputs regeneration classifies). " +
    "An upper bound: a day whose cash or savings component the regenerator preserves keeps NULL, and only days inside a regeneration's window are rewritten. Frozen observed rows (`isEstimated = false`) are never rewritten by regeneration and are counted separately (whether their split is derivable: `frozen-restricted`).",
  "audit-021":
    "A frozen row is a past `SpaceSnapshot` day with `isEstimated = false`. It is a candidate when, at the end of that UTC day, its Space had an active link to a Plaid-fed bank account (checking, savings or debt; not manual) that existed for at least " +
    `${STALE_AFTER_DAYS} days and has NO BALANCES coverage row with \`freshnessAdvanced = true\` in the ${STALE_AFTER_DAYS} days up to that day's end, i.e. its balance was stale under the #302 rule. ` +
    "Materiality (the 1% share) is NOT applied, because no per-day account balance is stored: an upper bound. Days earlier than the ledger's first BALANCES row plus the horizon are undetermined. A balance written at token exchange (reconnect) is not in the ledger, so a reconnect day can read as stale.",
  "frozen-restricted":
    "No per-day account balance is stored: the as-of path (lib/data/accounts-asof-window.ts → resolveAccountsOverWindow) WALKS BACK from each account's current posted balance, subtracting the POSTED, non-deleted transactions dated after the day. " +
    `\`restrictedCash\` is the classifier's restricted share of checking + savings, i.e. accounts of type checking/savings whose \`providerSubtype\` is ${RESTRICTED_DEPOSITORY_SUBTYPES.map((x) => `\`${x}\``).join(", ")} (restricted investment subtypes never enter it). ` +
    "Among frozen observed rows (`isEstimated = false`) with NULL `restrictedCash`, a restricted-capable account counts for a day when its link to the Space was live at that day's end (created before, not revoked by) and it was not deleted by then. " +
    "A day is derivable when every such account is still live (its current balance is the walk's anchor) and its posted ledger reaches the day: it has a posted, non-deleted transaction dated on or before that day (the existence evidence lib/data/account-coverage.core.ts uses; the resolver's own floor, max(account created, link created), is always met on a linked day, so it cannot discriminate). " +
    "Derivable is an UPPER bound: the walk treats a day with no posted rows as no movement, so a gap in the synced transaction history after the day, a pending-to-posted change or an anchor that was never observed (FIN-A2) still yields a number, which may be wrong. " +
    "A day with no restricted-capable account has a restricted share of exactly 0 (the classification uses the subtype stored today). The rest are not derivable. REPORT ONLY: no fill and no apply exist; filling frozen rows is a separate owner-gated repair.",
};

// ── client seam ──────────────────────────────────────────────────────────────

export interface ReadOnlyTx {
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
}
export interface ReadOnlyClient {
  $transaction<T>(fn: (tx: ReadOnlyTx) => Promise<T>, opts?: { maxWait?: number; timeout?: number }): Promise<T>;
}

/** The FIRST statement of every report transaction. Transaction-scoped by construction. */
export const READ_ONLY_STATEMENT = "SET TRANSACTION READ ONLY";
export const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '120s'";

export const PRINCIPAL_SQL = `SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`;
export const PRINCIPAL_REFUSAL =
  "the reporting principal must bypass RLS (rolbypassrls or rolsuper): under row-level security a count silently misses rows.";

const COLUMNS_SQL = `SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()`;

// ── SQL (aggregates only) ────────────────────────────────────────────────────

export const COINGECKO_SQL = `
SELECT i."tickerSymbol" AS ticker,
       count(*)::int AS rows,
       to_char(min(p.date), 'YYYY-MM-DD') AS "minDate",
       to_char(max(p.date), 'YYYY-MM-DD') AS "maxDate",
       (max(p.date) - min(p.date) + 1)::int AS "spanDays",
       to_char(p."fetchedAt", 'YYYY-MM-DD') AS "fetchedDate"
  FROM "PriceObservation" p
  JOIN "Instrument" i ON i.id = p."instrumentId"
 WHERE p.basis = 'RAW_CLOSE'
   AND (p.source = 'coingecko' OR p.source LIKE 'coingecko:%')
 GROUP BY p."instrumentId", i."tickerSymbol", p.source, p."fetchedAt"`;

const BALANCE_OBSERVED = `c.endpoint = 'BALANCES' AND c.status = 'COVERED' AND c."freshnessAdvanced" = true`;

export const FIN_A2_SQL = `
WITH ledger AS (
  SELECT min(c."createdAt") AS start FROM "RefreshEndpointAccountCoverage" c WHERE c.endpoint = 'BALANCES'
), cand AS (
  SELECT fa."createdAt" AS created, fa.type::text AS type, (fa."balanceLastUpdatedAt" IS NULL) AS "noInstitutionClock"
    FROM "FinancialAccount" fa
   WHERE fa."plaidAccountId" IS NOT NULL AND fa."deletedAt" IS NULL
     AND fa.balance = 0 AND fa."balanceObserved" = true
     AND NOT EXISTS (SELECT 1 FROM "RefreshEndpointAccountCoverage" c
                      WHERE c."financialAccountId" = fa.id AND ${BALANCE_OBSERVED} AND c."createdAt" >= fa."createdAt")
)
SELECT (SELECT count(*)::int FROM "FinancialAccount" fa WHERE fa."plaidAccountId" IS NOT NULL AND fa."deletedAt" IS NULL) AS "plaidAccounts",
       (SELECT count(*)::int FROM cand) AS candidates,
       (SELECT count(*)::int FROM cand, ledger WHERE ledger.start IS NOT NULL AND cand.created >= ledger.start) AS "inLedger",
       (SELECT count(*)::int FROM cand, ledger WHERE ledger.start IS NULL OR cand.created < ledger.start) AS "preLedger",
       (SELECT count(*)::int FROM cand WHERE "noInstitutionClock") AS "noInstitutionClock",
       (SELECT to_char(min(created), 'YYYY-MM-DD') FROM cand) AS "minCreated",
       (SELECT to_char(max(created), 'YYYY-MM-DD') FROM cand) AS "maxCreated",
       (SELECT to_char(start, 'YYYY-MM-DD') FROM ledger) AS "ledgerStart",
       (SELECT coalesce(json_object_agg(type, n), '{}'::json) FROM (SELECT type, count(*)::int AS n FROM cand GROUP BY type) t) AS "byType"`;

export const FIN_E_SQL = `
WITH rows AS (
  SELECT s."spaceId", s.date, s."isEstimated",
         EXISTS (SELECT 1 FROM "SpaceAccountLink" l JOIN "FinancialAccount" fa ON fa.id = l."financialAccountId"
                  WHERE l."spaceId" = s."spaceId" AND l.status = 'ACTIVE' AND fa."deletedAt" IS NULL) AS "hasInputs"
    FROM "SpaceSnapshot" s
   WHERE s."restrictedCash" IS NULL
)
SELECT (SELECT count(*)::int FROM "SpaceSnapshot") AS "allRows",
       count(*)::int AS "nullRows",
       count(*) FILTER (WHERE "isEstimated" AND "hasInputs")::int AS "fillableRows",
       count(DISTINCT "spaceId") FILTER (WHERE "isEstimated" AND "hasInputs")::int AS "fillableSpaces",
       to_char(min(date) FILTER (WHERE "isEstimated" AND "hasInputs"), 'YYYY-MM-DD') AS "fillableFrom",
       to_char(max(date) FILTER (WHERE "isEstimated" AND "hasInputs"), 'YYYY-MM-DD') AS "fillableTo",
       count(*) FILTER (WHERE NOT "isEstimated")::int AS "frozenRows",
       count(DISTINCT "spaceId") FILTER (WHERE NOT "isEstimated")::int AS "frozenSpaces",
       to_char(min(date) FILTER (WHERE NOT "isEstimated"), 'YYYY-MM-DD') AS "frozenFrom",
       to_char(max(date) FILTER (WHERE NOT "isEstimated"), 'YYYY-MM-DD') AS "frozenTo",
       count(*) FILTER (WHERE "isEstimated" AND NOT "hasInputs")::int AS "noInputRows"
  FROM rows`;

export const AUDIT_021_SQL = `
WITH ledger AS (
  SELECT min(c."createdAt") AS start FROM "RefreshEndpointAccountCoverage" c WHERE c.endpoint = 'BALANCES'
), frozen AS (
  SELECT s."spaceId", s.date, (s.date + 1)::timestamp AS "dayEnd"
    FROM "SpaceSnapshot" s
   WHERE s."isEstimated" = false AND s.date < (now() AT TIME ZONE 'UTC')::date
), judged AS (
  SELECT f."spaceId", f.date,
    CASE
      WHEN ledger.start IS NULL OR f."dayEnd" - interval '${STALE_AFTER_DAYS} days' < ledger.start THEN 'UNDETERMINED'
      WHEN EXISTS (
        SELECT 1 FROM "SpaceAccountLink" l JOIN "FinancialAccount" fa ON fa.id = l."financialAccountId"
         WHERE l."spaceId" = f."spaceId"
           AND l."createdAt" < f."dayEnd" AND (l."revokedAt" IS NULL OR l."revokedAt" >= f."dayEnd")
           AND fa.type::text IN ('checking', 'savings', 'debt')
           AND fa."syncStatus" IS DISTINCT FROM 'manual' AND fa."plaidAccountId" IS NOT NULL
           AND fa."createdAt" <= f."dayEnd" - interval '${STALE_AFTER_DAYS} days'
           AND (fa."deletedAt" IS NULL OR fa."deletedAt" >= f."dayEnd")
           AND NOT EXISTS (SELECT 1 FROM "RefreshEndpointAccountCoverage" c
                            WHERE c."financialAccountId" = fa.id AND ${BALANCE_OBSERVED}
                              AND c."createdAt" > f."dayEnd" - interval '${STALE_AFTER_DAYS} days' AND c."createdAt" <= f."dayEnd")
      ) THEN 'CANDIDATE'
      ELSE 'CLEAR'
    END AS verdict
    FROM frozen f CROSS JOIN ledger
)
SELECT verdict, count(*)::int AS rows, count(DISTINCT "spaceId")::int AS spaces,
       to_char(min(date), 'YYYY-MM-DD') AS "fromDate", to_char(max(date), 'YYYY-MM-DD') AS "toDate"
  FROM judged GROUP BY verdict`;

/**
 * Frozen observed rows with NULL restrictedCash → DERIVABLE | NOT_DERIVABLE |
 * TRIVIAL_ZERO. The as-of ladder (accounts-asof.core resolveOne +
 * account-coverage.core BALANCE_WALK) walks cash back from today's posted
 * balance. Its own floor, max(account created, link created), is always on or
 * before a day the account was linked, so it cannot tell a covered day from an
 * uncovered one; the discriminating fact is whether the account's POSTED ledger
 * reaches the day (a posted, non-deleted row dated on or before it). Links are
 * judged as of the day's end, the same view the frozen row's own cash had.
 */
const RESTRICTED_SUBTYPES_SQL = RESTRICTED_DEPOSITORY_SUBTYPES.map((x) => `'${x.replace(/'/g, "")}'`).join(", ");
export const FROZEN_RESTRICTED_SQL = `
WITH frozen AS (
  SELECT s."spaceId", s.date, (s.date + 1)::timestamp AS "dayEnd"
    FROM "SpaceSnapshot" s
   WHERE s."isEstimated" = false AND s."restrictedCash" IS NULL
), capable AS (
  SELECT f."spaceId", f.date, fa.id AS "accountId", (fa."deletedAt" IS NULL) AS "liveNow"
    FROM frozen f
    JOIN "SpaceAccountLink" l ON l."spaceId" = f."spaceId"
         AND l."createdAt" < f."dayEnd" AND (l."revokedAt" IS NULL OR l."revokedAt" >= f."dayEnd")
    JOIN "FinancialAccount" fa ON fa.id = l."financialAccountId"
   WHERE fa.type::text IN ('checking', 'savings')
     AND lower(btrim(fa."providerSubtype")) IN (${RESTRICTED_SUBTYPES_SQL})
     AND (fa."deletedAt" IS NULL OR fa."deletedAt" >= f."dayEnd")
), posted AS (
  SELECT t."financialAccountId" AS "accountId", min(t.date) AS "firstPosted"
    FROM "Transaction" t
   WHERE t."deletedAt" IS NULL AND t.pending = false
     AND t."financialAccountId" IN (SELECT "accountId" FROM capable)
   GROUP BY t."financialAccountId"
), per_day AS (
  SELECT c."spaceId", c.date,
         bool_and(c."liveNow" AND p."firstPosted" IS NOT NULL AND p."firstPosted" <= c.date) AS ok
    FROM capable c LEFT JOIN posted p ON p."accountId" = c."accountId"
   GROUP BY c."spaceId", c.date
), judged AS (
  SELECT f."spaceId", f.date,
         CASE WHEN d.ok IS NULL THEN 'TRIVIAL_ZERO' WHEN d.ok THEN 'DERIVABLE' ELSE 'NOT_DERIVABLE' END AS verdict
    FROM frozen f LEFT JOIN per_day d ON d."spaceId" = f."spaceId" AND d.date = f.date
)
SELECT verdict, count(*)::int AS rows, count(DISTINCT "spaceId")::int AS spaces,
       to_char(min(date), 'YYYY-MM-DD') AS "fromDate", to_char(max(date), 'YYYY-MM-DD') AS "toDate"
  FROM judged GROUP BY verdict`;

// ── result shapes ────────────────────────────────────────────────────────────

export interface CoinGeckoBatchRow { ticker: string | null; rows: number; minDate: string; maxDate: string; spanDays: number; fetchedDate: string }
export interface CoinSummary { coin: string; lateRows: number; lateFrom: string | null; lateTo: string | null; undeterminedRows: number; excludedRows: number }
export interface CoinGeckoResult { coins: CoinSummary[]; fixedFrom: string | null; lastLateFetch: string | null }

export interface FinA2Result {
  plaidAccounts: number; candidates: number; inLedger: number; preLedger: number; noInstitutionClock: number;
  minCreated: string | null; maxCreated: string | null; ledgerStart: string | null; byType: Record<string, number>;
}
export interface FinEResult {
  allRows: number; nullRows: number; fillableRows: number; fillableSpaces: number; fillableFrom: string | null; fillableTo: string | null;
  frozenRows: number; frozenSpaces: number; frozenFrom: string | null; frozenTo: string | null; noInputRows: number;
}
export interface Audit021Bucket { rows: number; spaces: number; fromDate: string | null; toDate: string | null }
export interface Audit021Result { candidate: Audit021Bucket; clear: Audit021Bucket; undetermined: Audit021Bucket }
export interface FrozenRestrictedResult { derivable: Audit021Bucket; notDerivable: Audit021Bucket; trivialZero: Audit021Bucket; total: Audit021Bucket }

export type ReportOutcome =
  | { report: ReportName; status: "UNAVAILABLE"; reason: string }
  | { report: "coingecko"; status: "OK"; data: CoinGeckoResult }
  | { report: "fin-a2"; status: "OK"; data: FinA2Result }
  | { report: "fin-e"; status: "OK"; data: FinEResult }
  | { report: "audit-021"; status: "OK"; data: Audit021Result }
  | { report: "frozen-restricted"; status: "OK"; data: FrozenRestrictedResult };

// ── pure logic ───────────────────────────────────────────────────────────────

/** A coin label safe for a public report: an uppercase ticker, or "other". */
export function coinLabel(ticker: string | null | undefined): string {
  const t = (ticker ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{1,10}$/.test(t) ? t : "other";
}

const minDate = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const maxDate = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a > b ? a : b);

/** Batch rows → per-coin late / undetermined / excluded counts. Pure. */
export function summarizeCoinGecko(batches: readonly CoinGeckoBatchRow[], fixedFrom: string | null): CoinGeckoResult {
  const by = new Map<string, CoinSummary>();
  let lastLateFetch: string | null = null;
  for (const b of batches) {
    const coin = coinLabel(b.ticker);
    const s = by.get(coin) ?? { coin, lateRows: 0, lateFrom: null, lateTo: null, undeterminedRows: 0, excludedRows: 0 };
    if (fixedFrom !== null && b.fetchedDate >= fixedFrom) s.excludedRows += b.rows;
    else if (b.spanDays >= COINGECKO_DEFINITE_DAILY_MIN_SPAN) {
      s.lateRows += b.rows;
      s.lateFrom = minDate(s.lateFrom, b.minDate);
      s.lateTo = maxDate(s.lateTo, b.maxDate);
      lastLateFetch = maxDate(lastLateFetch, b.fetchedDate);
    } else s.undeterminedRows += b.rows;
    by.set(coin, s);
  }
  return { coins: [...by.values()].sort((a, b) => a.coin.localeCompare(b.coin)), fixedFrom, lastLateFetch };
}

/** The required columns the target lacks, as "Table.column". Pure. */
export function missingColumns(report: ReportName, present: ReadonlySet<string>): string[] {
  return REQUIRED_COLUMNS[report].map(([t, c]) => `${t}.${c}`).filter((k) => !present.has(k));
}

const emptyBucket = (): Audit021Bucket => ({ rows: 0, spaces: 0, fromDate: null, toDate: null });
function bucketPicker(rows: ReadonlyArray<{ verdict: string } & Audit021Bucket>) {
  return (v: string): Audit021Bucket => {
    const r = rows.find((x) => x.verdict === v);
    return r ? { rows: r.rows, spaces: r.spaces, fromDate: r.fromDate, toDate: r.toDate } : emptyBucket();
  };
}

export function summarizeAudit021(rows: ReadonlyArray<{ verdict: string } & Audit021Bucket>): Audit021Result {
  const pick = bucketPicker(rows);
  return { candidate: pick("CANDIDATE"), clear: pick("CLEAR"), undetermined: pick("UNDETERMINED") };
}

/**
 * Verdict buckets → the frozen-restricted result. The total's row count is the
 * sum (each frozen row has exactly one verdict); its Space count is the largest
 * bucket's, a floor (a Space can sit in several buckets), so it is not printed.
 */
export function summarizeFrozenRestricted(rows: ReadonlyArray<{ verdict: string } & Audit021Bucket>): FrozenRestrictedResult {
  const pick = bucketPicker(rows);
  const derivable = pick("DERIVABLE"), notDerivable = pick("NOT_DERIVABLE"), trivialZero = pick("TRIVIAL_ZERO");
  const all = [derivable, notDerivable, trivialZero];
  return {
    derivable, notDerivable, trivialZero,
    total: {
      rows: all.reduce((s, b) => s + b.rows, 0),
      spaces: Math.max(...all.map((b) => b.spaces)),
      fromDate: all.reduce<string | null>((m, b) => minDate(m, b.fromDate), null),
      toDate: all.reduce<string | null>((m, b) => maxDate(m, b.toDate), null),
    },
  };
}

// ── runner ───────────────────────────────────────────────────────────────────

async function inReadOnlyTx<T>(client: ReadOnlyClient, fn: (tx: ReadOnlyTx) => Promise<T>): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(READ_ONLY_STATEMENT);
    await tx.$executeRawUnsafe(STATEMENT_TIMEOUT);
    return fn(tx);
  }, { maxWait: 10_000, timeout: 180_000 });
}

/** Null when the principal bypasses RLS; the refusal otherwise. */
export async function principalRefusal(client: ReadOnlyClient): Promise<string | null> {
  const rows = await inReadOnlyTx(client, (tx) => tx.$queryRawUnsafe<Array<{ ok: boolean | null }>>(PRINCIPAL_SQL));
  return rows.length === 1 && rows[0].ok === true ? null : PRINCIPAL_REFUSAL;
}

export async function runReport(client: ReadOnlyClient, report: ReportName, opts: { coingeckoFixedFrom?: string | null } = {}): Promise<ReportOutcome> {
  return inReadOnlyTx(client, async (tx) => {
    const cols = await tx.$queryRawUnsafe<Array<{ t: string; c: string }>>(COLUMNS_SQL);
    const missing = missingColumns(report, new Set(cols.map((r) => `${r.t}.${r.c}`)));
    if (missing.length) {
      return { report, status: "UNAVAILABLE", reason: `the target has no ${missing.join(", ")} (migration not applied there); not computed from a substitute.` };
    }
    switch (report) {
      case "coingecko": {
        const rows = await tx.$queryRawUnsafe<CoinGeckoBatchRow[]>(COINGECKO_SQL);
        return { report, status: "OK", data: summarizeCoinGecko(rows, opts.coingeckoFixedFrom ?? null) };
      }
      case "fin-a2": {
        const [r] = await tx.$queryRawUnsafe<FinA2Result[]>(FIN_A2_SQL);
        return { report, status: "OK", data: { ...r, byType: (r.byType ?? {}) as Record<string, number> } };
      }
      case "fin-e": {
        const [r] = await tx.$queryRawUnsafe<FinEResult[]>(FIN_E_SQL);
        return { report, status: "OK", data: r };
      }
      case "audit-021": {
        const rows = await tx.$queryRawUnsafe<Array<{ verdict: string } & Audit021Bucket>>(AUDIT_021_SQL);
        return { report, status: "OK", data: summarizeAudit021(rows) };
      }
      case "frozen-restricted": {
        const rows = await tx.$queryRawUnsafe<Array<{ verdict: string } & Audit021Bucket>>(FROZEN_RESTRICTED_SQL);
        return { report, status: "OK", data: summarizeFrozenRestricted(rows) };
      }
    }
  });
}

// ── rendering ────────────────────────────────────────────────────────────────

export const GOVERNANCE_LINES = [
  "Read-only. Preview/clone: engineering; Production: owner-run or owner-approved.",
  "`--acknowledge-production-read` is a safety rail, NOT approval: a Production run needs the owner's explicit approval for that run.",
  "Counts and date ranges only — no ids, amounts, names, emails or institutions.",
];

const TITLES: Record<ReportName, string> = {
  coingecko: "1. CoinGecko archive shift (FM-AUDIT-025)",
  "fin-a2": "2. Null-balance $0 accounts (FIN-A2)",
  "fin-e": "3. Restricted-cash snapshot fill (FIN-E)",
  "audit-021": "4. Frozen stale-observed snapshot rows (FM-AUDIT-021)",
  "frozen-restricted": "5. Frozen observed rows: derivable restricted-cash split (FIN-E)",
};

/**
 * S2 (#370): every figure row names its bound kind LITERALLY, so no count is read
 * as exact by accident. "exact" only where the figure is a plain count of stored
 * rows (populations, totals, and the separate undetermined / excluded counts).
 */
export const BOUND = {
  LOWER: "lower bound",
  UPPER: "upper bound",
  REVIEW: "review list (includes genuine $0)",
  EXACT: "exact",
} as const;
export const BOUND_LABELS: readonly string[] = Object.values(BOUND);

const range = (a: string | null, b: string | null) => (a === null || b === null ? "—" : a === b ? a : `${a} → ${b}`);
const n = (v: number) => String(Math.trunc(v));

export function renderReport(o: ReportOutcome): string {
  const L: string[] = [`### ${TITLES[o.report]}`, ""];
  if (o.status === "UNAVAILABLE") {
    L.push(`**UNAVAILABLE** — ${o.reason}`, "");
    return L.join("\n");
  }
  L.push(`*Heuristic:* ${HEURISTICS[o.report]}`, "");
  switch (o.report) {
    case "coingecko": {
      const d = o.data;
      L.push("| Coin | Measure | Rows | Date range | Bound |", "|---|---|---:|---|---|");
      for (const c of d.coins) {
        L.push(`| ${c.coin} | one day late | ${n(c.lateRows)} | ${range(c.lateFrom, c.lateTo)} | ${BOUND.LOWER} |`);
        L.push(`| ${c.coin} | undetermined | ${n(c.undeterminedRows)} | — | ${BOUND.EXACT} |`);
        if (c.excludedRows > 0) L.push(`| ${c.coin} | excluded (fetched after fix) | ${n(c.excludedRows)} | — | ${BOUND.EXACT} |`);
      }
      const t = d.coins.reduce((s, c) => ({ l: s.l + c.lateRows, u: s.u + c.undeterminedRows, x: s.x + c.excludedRows,
        f: minDate(s.f, c.lateFrom), to: maxDate(s.to, c.lateTo) }), { l: 0, u: 0, x: 0, f: null as string | null, to: null as string | null });
      L.push(`| **All coins** | **one day late** | **${n(t.l)}** | ${range(t.f, t.to)} | ${BOUND.LOWER} |`,
        `| **All coins** | undetermined | ${n(t.u)} | — | ${BOUND.EXACT} |`,
        `| **All coins** | excluded (fetched after fix) | ${n(t.x)} | — | ${BOUND.EXACT} |`, "");
      L.push(d.fixedFrom
        ? `Batches fetched on or after ${d.fixedFrom} excluded (\`--coingecko-fixed-from\`).`
        : `\`--coingecko-fixed-from\` not given: no batch excluded. Latest fetch date among late batches: ${d.lastLateFetch ?? "—"} (compare with the #300 deploy date on this environment).`,
        "Undetermined rows are a separate count of rows the heuristic cannot classify; they are never part of the lower bound.", "");
      break;
    }
    case "fin-a2": {
      const d = o.data;
      L.push("| Measure | Count | Bound |", "|---|---:|---|",
        `| Live Plaid accounts (population) | ${n(d.plaidAccounts)} | ${BOUND.EXACT} |`,
        `| **Candidates** ($0, observed flag set, no observed balance since creation) | **${n(d.candidates)}** | ${BOUND.REVIEW} |`,
        `| — created after the ledger began (higher confidence) | ${n(d.inLedger)} | ${BOUND.REVIEW} |`,
        `| — created before the ledger began (ledger-blind) | ${n(d.preLedger)} | ${BOUND.REVIEW} |`,
        `| — of which no institution balance clock either | ${n(d.noInstitutionClock)} | ${BOUND.REVIEW} |`);
      for (const [type, c] of Object.entries(d.byType).sort()) L.push(`| — type ${/^[a-z_]{1,20}$/.test(type) ? type : "other"} | ${n(c)} | ${BOUND.REVIEW} |`);
      L.push("", `Candidates created: ${range(d.minCreated, d.maxCreated)}. Balance ledger begins: ${d.ledgerStart ?? "— (no BALANCES rows)"}.`,
        "For accounts refreshed before FIN-011 the candidate count is also a lower bound (a refresh then could mark a null balance as advanced).", "");
      break;
    }
    case "fin-e": {
      const d = o.data;
      L.push("| Measure | Days (rows) | Spaces | Date range | Bound |", "|---|---:|---:|---|---|",
        `| **Fillable by regeneration** (estimate, NULL, inputs present) | **${n(d.fillableRows)}** | **${n(d.fillableSpaces)}** | ${range(d.fillableFrom, d.fillableTo)} | ${BOUND.UPPER} |`,
        `| Frozen observed rows with NULL (regeneration never rewrites) | ${n(d.frozenRows)} | ${n(d.frozenSpaces)} | ${range(d.frozenFrom, d.frozenTo)} | ${BOUND.EXACT} |`,
        `| Estimate rows with NULL and no active account inputs | ${n(d.noInputRows)} | — | — | ${BOUND.EXACT} |`,
        `| All rows with NULL / all snapshot rows | ${n(d.nullRows)} / ${n(d.allRows)} | — | — | ${BOUND.EXACT} |`, "");
      break;
    }
    case "audit-021": {
      const d = o.data;
      L.push("| Frozen rows | Days (rows) | Spaces | Date range | Bound |", "|---|---:|---:|---|---|",
        `| **Candidates** (stale bank input under #302) | **${n(d.candidate.rows)}** | **${n(d.candidate.spaces)}** | ${range(d.candidate.fromDate, d.candidate.toDate)} | ${BOUND.UPPER} |`,
        `| Clear | ${n(d.clear.rows)} | ${n(d.clear.spaces)} | ${range(d.clear.fromDate, d.clear.toDate)} | ${BOUND.LOWER} |`,
        `| Undetermined (before the balance ledger) | ${n(d.undetermined.rows)} | ${n(d.undetermined.spaces)} | ${range(d.undetermined.fromDate, d.undetermined.toDate)} | ${BOUND.EXACT} |`, "",
        "Undetermined is a separate count, never folded into the candidate upper bound.", "");
      break;
    }
    case "frozen-restricted": {
      const d = o.data;
      L.push("| Frozen rows | Days (rows) | Spaces | Date range | Bound |", "|---|---:|---:|---|---|",
        `| **Derivable** (every restricted-capable account linked that day is inside its walk-back coverage) | **${n(d.derivable.rows)}** | **${n(d.derivable.spaces)}** | ${range(d.derivable.fromDate, d.derivable.toDate)} | ${BOUND.UPPER} |`,
        `| Not derivable (a restricted-capable account's posted ledger does not reach the day, or it is deleted since) | ${n(d.notDerivable.rows)} | ${n(d.notDerivable.spaces)} | ${range(d.notDerivable.fromDate, d.notDerivable.toDate)} | ${BOUND.EXACT} |`,
        `| No restricted-capable accounts: the split is trivially 0 | ${n(d.trivialZero.rows)} | ${n(d.trivialZero.spaces)} | ${range(d.trivialZero.fromDate, d.trivialZero.toDate)} | ${BOUND.EXACT} |`,
        `| All frozen observed rows with NULL restrictedCash (population) | ${n(d.total.rows)} | — | ${range(d.total.fromDate, d.total.toDate)} | ${BOUND.EXACT} |`, "",
        "REPORT ONLY: this tool has no fill and no apply. Any fill of frozen rows (which regeneration never rewrites) is a separate owner-gated repair.", "");
      break;
    }
  }
  return L.join("\n");
}

export function renderDocument(env: string, generatedAtISO: string, outcomes: readonly ReportOutcome[]): string {
  return [
    `## B10.5 owner-decision counts — ${env}`,
    "",
    `Generated ${generatedAtISO.slice(0, 16).replace("T", " ")} UTC by \`scripts/b10-5-decision-report.ts\`.`,
    "",
    ...GOVERNANCE_LINES.map((l) => `- ${l}`),
    "",
    ...outcomes.map(renderReport),
  ].join("\n");
}

/**
 * The output contract, as a predicate (pinned by the tests): no cuid-shaped id,
 * no money-looking decimal, no email address, no connection string.
 */
export const OUTPUT_LEAK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["cuid-shaped id", /\bc[a-z0-9]{24}\b/],
  ["money-looking decimal", /\d\.\d{2}\b/],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["connection string", /postgres(?:ql)?:\/\//i],
];
export function outputLeaks(text: string): string[] {
  return OUTPUT_LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}
