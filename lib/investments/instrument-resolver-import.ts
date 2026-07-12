/**
 * lib/investments/instrument-resolver-import.ts
 *
 * A7 — import / manual instrument identity binding. A SIBLING of the Plaid
 * resolver (lib/investments/instrument-resolver.ts), never an edit to it: the
 * Plaid binding resolves a Plaid `Security`; this binding resolves the identity
 * an imported CSV row or a manual opening-position assertion carries — a ticker
 * symbol plus optional strong ids / name / currency. Both share the ONE pure
 * precedence engine `decideResolution` (imported here, read-only), so identity
 * doctrine cannot drift between providers.
 *
 * Resolution order (investigation §3.4):
 *   1. learned provider alias (e.g. "csv:schwab" externalId) — deterministic repeats
 *   2. strong id (CUSIP / ISIN) — refuse an ambiguous or conflicting merge
 *   3. weak key (tickerSymbol, currency) — exactly one match, else refuse
 *   4. create a fresh weak-key identity (+ alias when a provider namespace is given)
 *
 * "Never guess": a strong-id conflict OR an ambiguous weak key returns
 * `{ conflict: true }` with NO write — the caller surfaces it (a manual assertion
 * asks the user to pick an existing instrument; an import lists it in preview).
 * This is stricter than the Plaid binding, which creates-and-flags to keep an
 * unattended sync moving; imports are interactive, so they refuse.
 */

import { AssetClass, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";
import { decideResolution } from "@/lib/investments/instrument-resolver";

type Client = PrismaClient | Prisma.TransactionClient;

/** The identity an imported row / manual assertion can supply. Name-free-safe. */
export interface ImportInstrumentIdentity {
  /** Ticker symbol — the primary weak-key input. Null only for cash-leg rows. */
  symbol:   string | null;
  name?:    string | null;
  cusip?:   string | null;
  isin?:    string | null;
  currency?: string | null;
  /** Learned alias namespace (e.g. "csv:schwab"); manual assertions pass none. */
  aliasProvider?:   string | null;
  aliasExternalId?: string | null;
}

export interface ResolvedImportInstrument {
  instrumentId: string;
  created:      boolean;
  /** True ⇒ ambiguous / conflicting identity — NO instrument was resolved or written. */
  conflict:     boolean;
}

/** Read-only resolution outcome for preview (zero writes). */
export interface MatchedImportInstrument {
  /** Existing instrument id when one safely matches; null when it would be created. */
  instrumentId: string | null;
  wouldCreate:  boolean;
  conflict:     boolean;
}

/**
 * READ-ONLY identity resolution for preview — never writes. Same precedence as
 * resolveInstrumentForImport but returns "would create" instead of creating and
 * "conflict" instead of recording an issue, so preview is truly zero-write.
 */
export async function matchInstrumentForImport(
  identity: ImportInstrumentIdentity,
  opts?: { client?: Client },
): Promise<MatchedImportInstrument> {
  const client = opts?.client ?? db;

  const alias = identity.aliasProvider && identity.aliasExternalId
    ? await client.instrumentAlias.findUnique({
        where:  { provider_externalId: { provider: identity.aliasProvider, externalId: identity.aliasExternalId } },
        select: { instrumentId: true },
      })
    : null;
  if (alias) return { instrumentId: alias.instrumentId, wouldCreate: false, conflict: false };

  const strongWhere: Prisma.InstrumentWhereInput[] = [];
  if (identity.cusip) strongWhere.push({ cusip: identity.cusip });
  if (identity.isin)  strongWhere.push({ isin: identity.isin });
  const strongMatches = strongWhere.length === 0
    ? []
    : await client.instrument.findMany({ where: { OR: strongWhere }, select: { id: true, cusip: true, isin: true } });
  if (strongMatches.length > 1) return { instrumentId: null, wouldCreate: false, conflict: true };
  if (strongMatches.length === 1) {
    if (strongImportConflict(identity, strongMatches[0])) return { instrumentId: null, wouldCreate: false, conflict: true };
    return { instrumentId: strongMatches[0].id, wouldCreate: false, conflict: false };
  }

  if (identity.symbol) {
    const weak = await client.instrument.findMany({ where: { tickerSymbol: identity.symbol, currency: identity.currency ?? null }, select: { id: true }, take: 2 });
    if (weak.length > 1) return { instrumentId: null, wouldCreate: false, conflict: true };
    if (weak.length === 1) return { instrumentId: weak[0].id, wouldCreate: false, conflict: false };
  }
  return { instrumentId: null, wouldCreate: true, conflict: false };
}

/** Strong ids present on both that disagree ⇒ a genuine identity conflict. */
function strongImportConflict(
  id:   Pick<ImportInstrumentIdentity, "cusip" | "isin">,
  inst: { cusip: string | null; isin: string | null },
): boolean {
  if (id.cusip && inst.cusip && id.cusip !== inst.cusip) return true;
  if (id.isin && inst.isin && id.isin !== inst.isin) return true;
  return false;
}

/**
 * Resolve an import/manual identity to a canonical Instrument. Creates the
 * identity (and a provider alias when a namespace is supplied) only when nothing
 * safe to reuse exists. Best-effort callers pass a transaction client; this
 * performs writes only on the create path.
 */
export async function resolveInstrumentForImport(
  identity: ImportInstrumentIdentity,
  opts?: { client?: Client; financialAccountId?: string | null },
): Promise<ResolvedImportInstrument> {
  const client = opts?.client ?? db;

  // 1. Learned provider alias (fast path).
  const alias = identity.aliasProvider && identity.aliasExternalId
    ? await client.instrumentAlias.findUnique({
        where:  { provider_externalId: { provider: identity.aliasProvider, externalId: identity.aliasExternalId } },
        select: { instrumentId: true },
      })
    : null;

  // 2. Strong-identifier candidates (CUSIP / ISIN).
  const strongWhere: Prisma.InstrumentWhereInput[] = [];
  if (identity.cusip) strongWhere.push({ cusip: identity.cusip });
  if (identity.isin)  strongWhere.push({ isin: identity.isin });
  const strongMatches = alias || strongWhere.length === 0
    ? []
    : await client.instrument.findMany({ where: { OR: strongWhere }, select: { id: true, cusip: true, isin: true } });
  const strongConflict = strongMatches.length === 1 && strongImportConflict(identity, strongMatches[0]);

  // 3. Weak key (tickerSymbol, currency) — only when no alias / strong match.
  //    More than one match is AMBIGUOUS: refuse, never pick one.
  let weakMatchId: string | null = null;
  if (!alias && strongMatches.length === 0 && identity.symbol) {
    const weak = await client.instrument.findMany({
      where:  { tickerSymbol: identity.symbol, currency: identity.currency ?? null },
      select: { id: true },
      take:   2,
    });
    if (weak.length > 1) {
      await recordSyncIssue({
        kind: "INSTRUMENT_IDENTITY_CONFLICT",
        financialAccountId: opts?.financialAccountId ?? null,
        detail: { stage: "import-weak-ambiguous", symbol: identity.symbol, currency: identity.currency ?? null, matches: weak.map((w) => w.id) },
      });
      return { instrumentId: "", created: false, conflict: true };
    }
    weakMatchId = weak[0]?.id ?? null;
  }

  const decision = decideResolution({
    aliasInstrumentId:        alias?.instrumentId ?? null,
    strongMatchInstrumentIds: strongMatches.map((m) => m.id),
    strongConflict,
    weakMatchInstrumentId:    weakMatchId,
  });

  if (decision.action === "conflict") {
    await recordSyncIssue({
      kind: "INSTRUMENT_IDENTITY_CONFLICT",
      financialAccountId: opts?.financialAccountId ?? null,
      detail: { stage: "import-strong-conflict", symbol: identity.symbol, cusip: identity.cusip ?? null, isin: identity.isin ?? null, conflictingInstrumentIds: [...new Set(strongMatches.map((m) => m.id))] },
    });
    return { instrumentId: "", created: false, conflict: true };
  }

  if (decision.action === "use") {
    if (decision.attachAlias && identity.aliasProvider && identity.aliasExternalId) {
      await client.instrumentAlias.upsert({
        where:  { provider_externalId: { provider: identity.aliasProvider, externalId: identity.aliasExternalId } },
        create: { instrumentId: decision.instrumentId, provider: identity.aliasProvider, externalId: identity.aliasExternalId, metadata: decision.aliasBootstrap ? { bootstrap: true } : {} },
        update: {},
      });
    }
    return { instrumentId: decision.instrumentId, created: false, conflict: false };
  }

  // action === "create" — a fresh weak-key identity. AssetClass UNKNOWN: an
  // import row / manual assertion does not state one (MC1: never fabricated).
  const created = await client.instrument.create({
    data: {
      tickerSymbol: identity.symbol,
      name:         identity.name ?? null,
      cusip:        identity.cusip ?? null,
      isin:         identity.isin ?? null,
      currency:     identity.currency ?? null,
      assetClass:   AssetClass.UNKNOWN,
      ...(identity.aliasProvider && identity.aliasExternalId
        ? { aliases: { create: { provider: identity.aliasProvider, externalId: identity.aliasExternalId, metadata: { bootstrap: true } } } }
        : {}),
    },
    select: { id: true },
  });
  return { instrumentId: created.id, created: true, conflict: false };
}
