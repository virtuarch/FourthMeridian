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
  type Prisma, type PrismaClient,
} from "@prisma/client";
import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { repairReconstructionForAccount } from "@/lib/investments/reconstruction-runner";
import {
  resolveInstrumentForImport, matchInstrumentForImport, type ImportInstrumentIdentity,
} from "@/lib/investments/instrument-resolver-import";
import { investmentImportsEnabled } from "@/lib/investments/opening-position";
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
  client: Pick<PrismaClient, "investmentEvent">,
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
  client?: PrismaClient;
}): Promise<PreviewResult> {
  const client = input.client ?? db;
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
  client?: PrismaClient;
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
  const client = input.client ?? db;
  const now = input.now ?? new Date();
  const { financialAccountId, userId, profileKey, profileVersion } = input;
  const decisions = input.userDecisions ?? {};

  const batch = await client.importBatch.create({
    data: {
      financialAccountId, createdByUserId: userId, source: input.source,
      kind: "INVESTMENT_HISTORY", status: ImportBatchStatus.PROCESSING,
      rowCount: input.rows.length, originalFilename: input.originalFilename ?? null,
      resolvedColumnMapping: input.resolvedColumnMapping,
      userDecisions: decisions as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  const candidates = await fetchCandidates(client, financialAccountId, input.rows);
  const counts: ImportCounts = { create: 0, match: 0, skip: 0, failed: 0 };
  const errorRows: { line: number; reason: string }[] = [];
  const touchedInstruments = new Set<string>();
  const createdEventByInstrument = new Map<string, { id: string; date: string }[]>();
  let touchedCash = false;

  for (const row of input.rows) {
    const decision = decisions[row.externalEventId];
    if (decision?.outcome === "exclude") { counts.skip++; continue; }
    if (row.error || !row.date) { counts.failed++; errorRows.push({ line: row.lineNumber, reason: row.error ?? "Missing date." }); continue; }
    const date = toDate(row.date);

    // Resolve instrument (writes on the create path) when the row names one.
    let instrumentId: string | null = null;
    if (row.symbol) {
      const inst = await resolveInstrumentForImport(identityOf(row, profileKey), { client, financialAccountId });
      if (inst.conflict) { counts.skip++; errorRows.push({ line: row.lineNumber, reason: `Ambiguous instrument for ${row.symbol}.` }); continue; }
      instrumentId = inst.instrumentId;
    }

    if (row.rowKind === "POSITION") {
      if (!instrumentId) { counts.skip++; errorRows.push({ line: row.lineNumber, reason: "Position row without a resolvable instrument." }); continue; }
      await client.positionObservation.upsert({
        where: { financialAccountId_instrumentId_date_origin_source: { financialAccountId, instrumentId, date, origin: PositionOrigin.IMPORTED, source: profileKey } },
        create: { financialAccountId, instrumentId, date, origin: PositionOrigin.IMPORTED, source: profileKey, quantity: row.quantity ?? 0, costBasis: row.costBasis, currency: row.currency, importBatchId: batch.id },
        update: { quantity: row.quantity ?? 0, costBasis: row.costBasis, importBatchId: batch.id, deletedAt: null, supersededById: null },
      });
      counts.create++; touchedInstruments.add(instrumentId);
      continue;
    }

    // TRANSACTION
    const type = decision?.outcome === "remap" ? decision.type : (row.type ?? InvestmentEventType.UNKNOWN);
    const dedupeRow: DedupeRow = { source: profileKey, externalEventId: row.externalEventId, date: row.date, type, instrumentId, quantity: row.quantity, amount: row.amount, ratio: row.ratio };
    const res = decision?.outcome === "force-create" ? { outcome: "CREATE" as const, matchedId: null, reason: "override" } : decideInvestmentRowOutcome(dedupeRow, candidates);
    if (res.outcome === "MATCH") { counts.match++; continue; }          // never mutate, never claim
    if (res.outcome === "SKIP_AMBIGUOUS") { counts.skip++; errorRows.push({ line: row.lineNumber, reason: res.reason }); continue; }

    const ev = await client.investmentEvent.create({
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
    counts.create++;
    if (instrumentId) {
      touchedInstruments.add(instrumentId);
      const list = createdEventByInstrument.get(instrumentId) ?? [];
      list.push({ id: ev.id, date: row.date });
      createdEventByInstrument.set(instrumentId, list);
    } else {
      touchedCash = true;
    }
  }

  // Supersession: imported history explains a weaker USER_ASSERTED opening for a
  // touched instrument (a created event dated on/before the assertion) ⇒ point
  // its supersededById at that imported evidence (append + supersede, never erase).
  let supersededAssertions = 0;
  for (const instrumentId of touchedInstruments) {
    const created = createdEventByInstrument.get(instrumentId) ?? [];
    if (created.length === 0) continue;
    const earliest = created.reduce((a, b) => (a.date <= b.date ? a : b));
    const openings = await client.investmentEvent.findMany({
      where: { financialAccountId, instrumentId, type: InvestmentEventType.OPENING_BALANCE, source: USER_SOURCE, deletedAt: null, supersededById: null },
      select: { id: true, date: true },
    });
    const covered = openings.filter((o) => earliest.date <= ymd(o.date));
    if (covered.length === 0) continue;
    await client.investmentEvent.updateMany({ where: { id: { in: covered.map((o) => o.id) } }, data: { supersededById: earliest.id } });
    const obs = await client.positionObservation.findMany({
      where: { financialAccountId, instrumentId, origin: PositionOrigin.USER_ASSERTED, source: USER_SOURCE, deletedAt: null, supersededById: null },
      select: { id: true },
    });
    if (obs.length > 0) await client.positionObservation.updateMany({ where: { id: { in: obs.map((o) => o.id) } }, data: { supersededById: earliest.id } });
    supersededAssertions += covered.length;
  }

  const finalStatus = counts.failed > 0 || counts.skip > 0 ? ImportBatchStatus.COMPLETED_WITH_ERRORS : ImportBatchStatus.COMPLETED;
  await client.importBatch.update({
    where: { id: batch.id },
    data: {
      importedCount: counts.create, matchedCount: counts.match, skippedCount: counts.skip, failedCount: counts.failed,
      status: finalStatus, completedAt: now,
      ...(errorRows.length > 0 ? { errorSummary: { rows: errorRows } as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  const affectedWindow = computeAffectedWindow({ financialAccountId, instrumentIds: [...touchedInstruments], dates: input.rows.map((r) => r.date), toDate: ymd(now) });

  let repair: CommitResult["repair"];
  try {
    const m = await repairReconstructionForAccount({ financialAccountId, affectedInstrumentIds: [...touchedInstruments], affectedCash: touchedCash, now, client });
    repair = { status: m.status, repairedInstrumentIds: m.repairedInstrumentIds };
  } catch (err) {
    console.warn(`[investment-import] reconstruction repair for account ${financialAccountId} failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    await recordSyncIssue({ kind: "UPSERT_ERROR", financialAccountId, detail: { stage: "investment-import-repair", error: err instanceof Error ? err.message : String(err) } }, client);
  }

  return { status: "ok", batchId: batch.id, counts, supersededAssertions, affectedWindow, repair };
}
