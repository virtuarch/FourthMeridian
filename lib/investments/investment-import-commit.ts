/**
 * lib/investments/investment-import-commit.ts
 *
 * A7-4 — the investment import commit path. Its OWN module (not the Plaid ingest
 * file — investment-event-ingest.ts stays A8's), mirroring the ingest template:
 * batched candidate fetch → dedupe → sequential writes → supersession → bounded
 * repair. Kill-switched under INVESTMENT_IMPORTS_ENABLED.
 *
 *   previewInvestmentImport  — ZERO writes: resolve (read-only), classify, warn.
 *   commitInvestmentImport   — create ImportBatch(kind INVESTMENT_HISTORY), write
 *                              CREATE rows (importBatchId + importedRaw +
 *                              mapperVersion), MATCH never mutates/claims,
 *                              SKIP/FAILED into errorSummary, POSITION rows upsert
 *                              PositionObservation(origin IMPORTED), imported
 *                              evidence supersedes weaker USER_ASSERTED openings,
 *                              finalize counters, bounded repair.
 *   computeAffectedWindow    — the (accounts, instruments, from, to) window A9's
 *                              regeneration will consume (called by nobody yet).
 *
 * Provider/source strings stay profile-specific ("csv:schwab"), so
 * [source, externalEventId] never collides across brokers.
 */

import {
  ImportBatchStatus, ImportSource, InvestmentEventType, PositionOrigin,
  type Prisma,
} from "@prisma/client";
import type { SyncIssueInput } from "@/lib/plaid/syncIssues";
import { assertEveryObservedRowWasWritten } from "@/lib/db/conditional-write";
import { repairReconstructionForAccount } from "@/lib/investments/reconstruction-runner";
import {
  resolveInstrumentForImport, matchInstrumentForImport, type ImportInstrumentIdentity,
} from "@/lib/investments/instrument-resolver-import";
import {
  investmentImportsEnabled, REPAIR_PHASE_TIMEOUT_MS,
  type InvestmentTenantPhase, type InvestmentIssueRecorder,
} from "@/lib/investments/opening-position";
import { decideInvestmentRowOutcome, type DedupeCandidate, type DedupeRow } from "@/lib/imports/investments/dedupe";
import type { NormalizedInvestmentRow } from "@/lib/imports/investments/types";

const USER_SOURCE = "user";

/** Per-row user override at preview, keyed by externalEventId (recorded in userDecisions). */
export type RowOverride =
  | { outcome: "force-create" }
  | { outcome: "exclude" }
  | { outcome: "remap"; type: InvestmentEventType };
export type UserDecisions = Record<string, RowOverride>;

export type RowOutcome = "CREATE" | "MATCH" | "SKIP_AMBIGUOUS" | "FAILED" | "AMBIGUOUS_INSTRUMENT" | "EXCLUDED";

export interface ClassifiedRow {
  externalEventId: string;
  lineNumber:      number;
  rowKind:         "TRANSACTION" | "POSITION";
  symbol:          string | null;
  type:            InvestmentEventType | null;
  outcome:         RowOutcome;
  matchedSource:   string | null;
  instrumentId:    string | null;
  wouldCreateInstrument: boolean;
  warnings:        string[];
}

export interface ImportCounts { create: number; match: number; skip: number; failed: number }

function ymd(d: Date): string { return d.toISOString().slice(0, 10); }
function toDate(s: string): Date { return new Date(`${s}T00:00:00.000Z`); }

function identityOf(row: NormalizedInvestmentRow, profileKey: string): ImportInstrumentIdentity {
  return { symbol: row.symbol, cusip: row.cusip, currency: row.currency, name: row.description, aliasProvider: profileKey, aliasExternalId: row.symbol };
}

async function fetchCandidates(
  client: Pick<Prisma.TransactionClient, "investmentEvent">,
  financialAccountId: string,
  rows: NormalizedInvestmentRow[],
): Promise<DedupeCandidate[]> {
  const dates = rows.map((r) => r.date).filter((d): d is string => !!d);
  if (dates.length === 0) return [];
  const min = dates.reduce((a, b) => (a < b ? a : b));
  const max = dates.reduce((a, b) => (a > b ? a : b));
  const evs = await client.investmentEvent.findMany({
    where: { financialAccountId, deletedAt: null, supersededById: null, date: { gte: toDate(min), lte: toDate(max) } },
    select: { id: true, source: true, externalEventId: true, date: true, type: true, instrumentId: true, quantity: true, amount: true, ratio: true },
  });
  return evs.map((e) => ({ ...e, date: ymd(e.date) }));
}

// ── Preview (zero writes) ──────────────────────────────────────────────────────

export interface PreviewResult {
  rows:   ClassifiedRow[];
  counts: ImportCounts;
}

export async function previewInvestmentImport(input: {
  financialAccountId: string;
  profileKey: string;
  rows: NormalizedInvestmentRow[];
  userDecisions?: UserDecisions;
  /**
   * RLS-PREP-C — REQUIRED, and a READ client. This was `client?: PrismaClient`
   * resolved with `?? db`, and the preview route passed nothing, so a zero-write
   * preview classified a file against InvestmentEvent AS THE TABLE OWNER while
   * the route itself imported no `db` — invisible to the authority ratchet. The
   * preview is pure reads, so it needs no transaction opener; a tenant phase
   * client is exactly enough.
   */
  client: Prisma.TransactionClient;
}): Promise<PreviewResult> {
  const client = input.client;
  const decisions = input.userDecisions ?? {};
  const candidates = await fetchCandidates(client, input.financialAccountId, input.rows);
  const counts: ImportCounts = { create: 0, match: 0, skip: 0, failed: 0 };
  const out: ClassifiedRow[] = [];

  for (const row of input.rows) {
    const base = { externalEventId: row.externalEventId, lineNumber: row.lineNumber, rowKind: row.rowKind, symbol: row.symbol, type: row.type, matchedSource: null as string | null, instrumentId: null as string | null, wouldCreateInstrument: false, warnings: row.warnings };
    const decision = decisions[row.externalEventId];
    if (decision?.outcome === "exclude") { out.push({ ...base, outcome: "EXCLUDED" }); continue; }
    if (row.error) { counts.failed++; out.push({ ...base, outcome: "FAILED", warnings: [...row.warnings, row.error] }); continue; }

    let instrumentId: string | null = null, wouldCreate = false;
    if (row.symbol) {
      const m = await matchInstrumentForImport(identityOf(row, input.profileKey), { client });
      if (m.conflict) { counts.skip++; out.push({ ...base, outcome: "AMBIGUOUS_INSTRUMENT" }); continue; }
      instrumentId = m.instrumentId; wouldCreate = m.wouldCreate;
    }

    if (row.rowKind === "POSITION") { counts.create++; out.push({ ...base, outcome: "CREATE", instrumentId, wouldCreateInstrument: wouldCreate }); continue; }

    const type = decision?.outcome === "remap" ? decision.type : row.type;
    const dedupeRow: DedupeRow = { source: input.profileKey, externalEventId: row.externalEventId, date: row.date ?? "", type, instrumentId, quantity: row.quantity, amount: row.amount, ratio: row.ratio };
    const res = decision?.outcome === "force-create" ? { outcome: "CREATE" as const, matchedId: null } : decideInvestmentRowOutcome(dedupeRow, candidates);
    if (res.outcome === "MATCH") { counts.match++; const c = candidates.find((x) => x.id === res.matchedId); out.push({ ...base, outcome: "MATCH", matchedSource: c?.source ?? null, instrumentId }); continue; }
    if (res.outcome === "SKIP_AMBIGUOUS") { counts.skip++; out.push({ ...base, outcome: "SKIP_AMBIGUOUS", instrumentId }); continue; }
    counts.create++; out.push({ ...base, outcome: "CREATE", instrumentId, wouldCreateInstrument: wouldCreate });
  }
  return { rows: out, counts };
}

// ── Commit (writes) ─────────────────────────────────────────────────────────────

export interface CommitInput {
  financialAccountId: string;
  userId: string;
  profileKey: string;
  profileVersion: number;
  source: ImportSource;
  originalFilename?: string | null;
  resolvedColumnMapping: Prisma.InputJsonValue;
  rows: NormalizedInvestmentRow[];
  userDecisions?: UserDecisions;
  now?: Date;
  /**
   * RLS-PREP-2 — the writer holds NO database client. Every financial statement
   * runs in a phase `tenant` opens as the acting user on the tenant role, and
   * operator incidents go through `recordIssue`, which accepts one typed
   * incident and nothing else. The two-authority contract, and why telemetry is
   * only reachable after RLS has admitted the account, is recorded once in
   * lib/investments/opening-position.ts.
   */
  tenant:      InvestmentTenantPhase;
  recordIssue: InvestmentIssueRecorder;
}

export interface CommitResult {
  status: "ok" | "disabled";
  batchId: string | null;
  counts?: ImportCounts;
  supersededAssertions?: number;
  affectedWindow?: AffectedWindow;
  repair?: { status: string; repairedInstrumentIds: string[] };
}

export interface AffectedWindow {
  financialAccountIds: string[];
  instrumentIds: string[];
  fromDate: string | null;
  toDate: string;
}

/** The regeneration window A9 will consume. Pure. */
export function computeAffectedWindow(args: { financialAccountId: string; instrumentIds: string[]; dates: (string | null)[]; toDate: string }): AffectedWindow {
  const ds = args.dates.filter((d): d is string => !!d);
  return {
    financialAccountIds: [args.financialAccountId],
    instrumentIds: [...new Set(args.instrumentIds)],
    fromDate: ds.length ? ds.reduce((a, b) => (a < b ? a : b)) : null,
    toDate: args.toDate,
  };
}

export async function commitInvestmentImport(input: CommitInput): Promise<CommitResult> {
  if (!investmentImportsEnabled()) return { status: "disabled", batchId: null };
  const { tenant, recordIssue } = input;
  const now = input.now ?? new Date();
  const { financialAccountId, userId, profileKey, profileVersion } = input;
  const decisions = input.userDecisions ?? {};

  // ── PHASE 1 — the batch, and the boundary ──────────────────────────────────
  // ImportBatch's INSERT policy is `fm_account_visible(financialAccountId)`, so
  // an account the acting user cannot see RAISES here, before a single row,
  // instrument or incident exists. Everything below — including telemetry —
  // stands behind this statement having succeeded as the tenant.
  const { batch, candidates } = await tenant(async (tx) => ({
    batch: await tx.importBatch.create({
      data: {
        financialAccountId, createdByUserId: userId, source: input.source,
        kind: "INVESTMENT_HISTORY", status: ImportBatchStatus.PROCESSING,
        rowCount: input.rows.length, originalFilename: input.originalFilename ?? null,
        resolvedColumnMapping: input.resolvedColumnMapping,
        userDecisions: decisions as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    }),
    candidates: await fetchCandidates(tx, financialAccountId, input.rows),
  }));

  const counts: ImportCounts = { create: 0, match: 0, skip: 0, failed: 0 };
  const errorRows: { line: number; reason: string }[] = [];
  const touchedInstruments = new Set<string>();
  const createdEventByInstrument = new Map<string, { id: string; date: string }[]>();
  let touchedCash = false;

  // ── PER-ROW PHASES ─────────────────────────────────────────────────────────
  // One tenant transaction PER ROW, which is what the autocommit root client
  // gave this loop before: rows already written stay written when a later row
  // raises, and the batch is left PROCESSING for rollback to find. What a row's
  // phase adds is that the instrument it mints and the event that needed it now
  // commit together. A refused write raises (create / upsert are keyed), so RLS
  // cannot turn a row into a silent no-op.
  type RowResult =
    | { kind: "conflict"; issue: SyncIssueInput | undefined }
    | { kind: "position-unresolved" }
    | { kind: "position"; instrumentId: string }
    | { kind: "match" }
    | { kind: "ambiguous"; reason: string }
    | { kind: "created"; eventId: string; instrumentId: string | null };

  for (const row of input.rows) {
    const decision = decisions[row.externalEventId];
    if (decision?.outcome === "exclude") { counts.skip++; continue; }
    if (row.error || !row.date) { counts.failed++; errorRows.push({ line: row.lineNumber, reason: row.error ?? "Missing date." }); continue; }
    const rowDate = row.date;
    const date = toDate(rowDate);

    const result = await tenant<RowResult>(async (tx) => {
      // Resolve instrument (writes on the create path) when the row names one.
      let instrumentId: string | null = null;
      if (row.symbol) {
        const inst = await resolveInstrumentForImport(identityOf(row, profileKey), { client: tx, financialAccountId });
        if (inst.conflict) return { kind: "conflict", issue: inst.issue };
        instrumentId = inst.instrumentId;
      }

      if (row.rowKind === "POSITION") {
        if (!instrumentId) return { kind: "position-unresolved" };
        await tx.positionObservation.upsert({
          where: { financialAccountId_instrumentId_date_origin_source: { financialAccountId, instrumentId, date, origin: PositionOrigin.IMPORTED, source: profileKey } },
          create: { financialAccountId, instrumentId, date, origin: PositionOrigin.IMPORTED, source: profileKey, quantity: row.quantity ?? 0, costBasis: row.costBasis, currency: row.currency, importBatchId: batch.id },
          update: { quantity: row.quantity ?? 0, costBasis: row.costBasis, importBatchId: batch.id, deletedAt: null, supersededById: null },
        });
        return { kind: "position", instrumentId };
      }

      // TRANSACTION
      const type = decision?.outcome === "remap" ? decision.type : (row.type ?? InvestmentEventType.UNKNOWN);
      const dedupeRow: DedupeRow = { source: profileKey, externalEventId: row.externalEventId, date: rowDate, type, instrumentId, quantity: row.quantity, amount: row.amount, ratio: row.ratio };
      const res = decision?.outcome === "force-create" ? { outcome: "CREATE" as const, matchedId: null, reason: "override" } : decideInvestmentRowOutcome(dedupeRow, candidates);
      if (res.outcome === "MATCH") return { kind: "match" };              // never mutate, never claim
      if (res.outcome === "SKIP_AMBIGUOUS") return { kind: "ambiguous", reason: res.reason };

      const ev = await tx.investmentEvent.create({
        data: {
          financialAccountId, instrumentId, type, date,
          quantity: row.quantity, price: row.price, amount: row.amount, fees: row.fees, currency: row.currency,
          source: profileKey, externalEventId: row.externalEventId, providerType: row.rawAction, description: row.description,
          mapperVersion: profileVersion, ratio: row.ratio,
          importBatchId: batch.id, createdByUserId: userId,
          importedRaw: row.importedRaw as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      return { kind: "created", eventId: ev.id, instrumentId };
    });

    switch (result.kind) {
      case "conflict":
        // The row's phase has ended and wrote nothing; telemetry runs now.
        if (result.issue) await recordIssue(result.issue);
        counts.skip++; errorRows.push({ line: row.lineNumber, reason: `Ambiguous instrument for ${row.symbol}.` });
        break;
      case "position-unresolved":
        counts.skip++; errorRows.push({ line: row.lineNumber, reason: "Position row without a resolvable instrument." });
        break;
      case "position":
        counts.create++; touchedInstruments.add(result.instrumentId);
        break;
      case "match":
        counts.match++;
        break;
      case "ambiguous":
        counts.skip++; errorRows.push({ line: row.lineNumber, reason: result.reason });
        break;
      case "created":
        counts.create++;
        if (result.instrumentId) {
          touchedInstruments.add(result.instrumentId);
          const list = createdEventByInstrument.get(result.instrumentId) ?? [];
          list.push({ id: result.eventId, date: rowDate });
          createdEventByInstrument.set(result.instrumentId, list);
        } else {
          touchedCash = true;
        }
        break;
    }
  }

  // Supersession: imported history explains a weaker USER_ASSERTED opening for a
  // touched instrument (a created event dated on/before the assertion) ⇒ point
  // its supersededById at that imported evidence (append + supersede, never erase).
  //
  // One tenant phase per instrument, so the opening event and its observation
  // anchor are superseded together. Both writes are count-returning: under RLS a
  // refused row is a smaller count, so each is checked against the rows the same
  // phase just observed.
  let supersededAssertions = 0;
  for (const instrumentId of touchedInstruments) {
    const created = createdEventByInstrument.get(instrumentId) ?? [];
    if (created.length === 0) continue;
    const earliest = created.reduce((a, b) => (a.date <= b.date ? a : b));
    supersededAssertions += await tenant(async (tx) => {
      const openings = await tx.investmentEvent.findMany({
        where: { financialAccountId, instrumentId, type: InvestmentEventType.OPENING_BALANCE, source: USER_SOURCE, deletedAt: null, supersededById: null },
        select: { id: true, date: true },
      });
      const covered = openings.filter((o) => earliest.date <= ymd(o.date));
      if (covered.length === 0) return 0;
      const ev = await tx.investmentEvent.updateMany({ where: { id: { in: covered.map((o) => o.id) } }, data: { supersededById: earliest.id } });
      assertEveryObservedRowWasWritten(
        { table: "InvestmentEvent", operation: "update", scope: `${covered.length} user opening(s) covered by imported history` },
        covered.length, ev.count,
      );
      const obs = await tx.positionObservation.findMany({
        where: { financialAccountId, instrumentId, origin: PositionOrigin.USER_ASSERTED, source: USER_SOURCE, deletedAt: null, supersededById: null },
        select: { id: true },
      });
      if (obs.length > 0) {
        const r = await tx.positionObservation.updateMany({ where: { id: { in: obs.map((o) => o.id) } }, data: { supersededById: earliest.id } });
        assertEveryObservedRowWasWritten(
          { table: "PositionObservation", operation: "update", scope: `${obs.length} user anchor(s) covered by imported history` },
          obs.length, r.count,
        );
      }
      return covered.length;
    });
  }

  const finalStatus = counts.failed > 0 || counts.skip > 0 ? ImportBatchStatus.COMPLETED_WITH_ERRORS : ImportBatchStatus.COMPLETED;
  // Keyed update: a refusal raises P2025 rather than reporting a finalized batch.
  await tenant((tx) => tx.importBatch.update({
    where: { id: batch.id },
    data: {
      importedCount: counts.create, matchedCount: counts.match, skippedCount: counts.skip, failedCount: counts.failed,
      status: finalStatus, completedAt: now,
      ...(errorRows.length > 0 ? { errorSummary: { rows: errorRows } as unknown as Prisma.InputJsonValue } : {}),
    },
    select: { id: true },
  }));

  const affectedWindow = computeAffectedWindow({ financialAccountId, instrumentIds: [...touchedInstruments], dates: input.rows.map((r) => r.date), toDate: ymd(now) });

  // Bounded repair in its OWN tenant phase: a failed repair rolls back alone and
  // the finalized import stands. Best-effort handling is outside the phase, and
  // the incident is recorded only after that phase has ended.
  let repair: CommitResult["repair"];
  try {
    const m = await tenant((tx) => repairReconstructionForAccount(tx, { financialAccountId, affectedInstrumentIds: [...touchedInstruments], affectedCash: touchedCash, now }), { timeout: REPAIR_PHASE_TIMEOUT_MS });
    repair = { status: m.status, repairedInstrumentIds: m.repairedInstrumentIds };
  } catch (err) {
    console.warn(`[investment-import] reconstruction repair for account ${financialAccountId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    await recordIssue({ kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", financialAccountId, detail: { stage: "investment-import-repair", error: err instanceof Error ? err.message : String(err) } });
  }

  return { status: "ok", batchId: batch.id, counts, supersededAssertions, affectedWindow, repair };
}
