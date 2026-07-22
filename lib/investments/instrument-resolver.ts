/**
 * lib/investments/instrument-resolver.ts
 *
 * Canonical investment Instrument identity resolution (Slice A1). Mirrors the
 * ProviderAccountIdentity / MerchantAlias convention: a pure decision core
 * (testable without a DB) plus a thin DB-binding wrapper.
 *
 * Identity precedence (never merges conflicting instruments):
 *   1. Exact provider alias  (provider="plaid", externalId=security_id)
 *   2. CUSIP  (strong, @unique)
 *   3. ISIN   (strong, @unique)
 *   4. SEDOL  (strong)
 *   5. Deterministic weak fallback (tickerSymbol + marketIdentifierCode)
 *   6. Create a new Instrument if no safe match exists
 *
 * On a strong-identifier conflict (a matched instrument disagrees on a strong
 * id, or two different instruments match different strong ids) the merge is
 * REFUSED: both existing records are preserved, a new Instrument is created for
 * this security, and a SyncIssue(INSTRUMENT_IDENTITY_CONFLICT) is recorded. We
 * never guess.
 *
 * Ticker is display metadata and a weak fallback — never the canonical key.
 * Raw Plaid metadata is preserved, not interpreted. FIGI is intentionally
 * absent (plaid@42.2.0 Security does not expose it).
 */

import type { Security } from "plaid";
import { AssetClass, type Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { recordSyncIssue } from "@/lib/plaid/syncIssues";

export const PLAID_PROVIDER = "plaid";

// ─── Pure core (no I/O) ───────────────────────────────────────────────────────

/** Map raw Plaid security type/subtype/cash-equivalent → canonical AssetClass. */
export function deriveAssetClass(sec: Pick<Security, "type" | "subtype" | "is_cash_equivalent">): AssetClass {
  if (sec.is_cash_equivalent) return AssetClass.CASH;
  switch ((sec.type ?? "").toLowerCase()) {
    case "cash":           return AssetClass.CASH;
    case "cryptocurrency": return AssetClass.CRYPTO;
    case "derivative":     return AssetClass.OPTION;
    case "equity":         return AssetClass.EQUITY;
    case "etf":            return AssetClass.ETF;
    case "fixed income":   return AssetClass.FIXED_INCOME;
    case "mutual fund":    return AssetClass.MUTUAL_FUND;
    case "":               return AssetClass.UNKNOWN;
    default:               return AssetClass.OTHER;
  }
}

/**
 * Map a Plaid Security to Instrument create fields — raw metadata preserved,
 * nulls kept (null = not provided; never fabricated). optionMeta/fixedIncomeMeta
 * are only included when Plaid supplied them.
 */
export function mapPlaidSecurityToInstrument(sec: Security): Prisma.InstrumentCreateInput {
  const input: Prisma.InstrumentCreateInput = {
    cusip:                sec.cusip ?? null,
    isin:                 sec.isin ?? null,
    sedol:                sec.sedol ?? null,
    tickerSymbol:         sec.ticker_symbol ?? null,
    name:                 sec.name ?? null,
    assetClass:           deriveAssetClass(sec),
    securityType:         sec.type ?? null,
    securitySubtype:      sec.subtype ?? null,
    marketIdentifierCode: sec.market_identifier_code ?? null,
    currency:             sec.iso_currency_code ?? sec.unofficial_currency_code ?? null,
    sector:               sec.sector ?? null,
    industry:             sec.industry ?? null,
    cfiCode:              sec.cfi_code ?? null,
    isCashEquivalent:     sec.is_cash_equivalent ?? null,
  };
  if (sec.option_contract) input.optionMeta = sec.option_contract as unknown as Prisma.InputJsonValue;
  if (sec.fixed_income)    input.fixedIncomeMeta = sec.fixed_income as unknown as Prisma.InputJsonValue;
  return input;
}

/** Strong identifiers present on both that disagree ⇒ a genuine identity conflict. */
export function strongIdsConflict(
  sec: Pick<Security, "cusip" | "isin" | "sedol">,
  inst: { cusip: string | null; isin: string | null; sedol: string | null },
): boolean {
  if (sec.cusip && inst.cusip && sec.cusip !== inst.cusip) return true;
  if (sec.isin && inst.isin && sec.isin !== inst.isin) return true;
  if (sec.sedol && inst.sedol && sec.sedol !== inst.sedol) return true;
  return false;
}

export type ResolutionDecision =
  | { action: "use"; instrumentId: string; attachAlias: boolean; aliasBootstrap: boolean }
  | { action: "conflict" }
  | { action: "create" };

/**
 * Pure precedence engine over already-fetched candidates. Deterministic:
 * identical inputs always yield the identical decision.
 */
export function decideResolution(input: {
  aliasInstrumentId: string | null;
  strongMatchInstrumentIds: string[]; // distinct ids matched by cusip/isin/sedol
  strongConflict: boolean;            // a single strong match disagrees on another strong id
  weakMatchInstrumentId: string | null;
}): ResolutionDecision {
  // 1. Provider alias is authoritative for that security_id → deterministic repeats.
  if (input.aliasInstrumentId) {
    return { action: "use", instrumentId: input.aliasInstrumentId, attachAlias: false, aliasBootstrap: false };
  }
  const distinct = [...new Set(input.strongMatchInstrumentIds)];
  // 2–4. Strong-id matches — refuse ambiguous or conflicting merges.
  if (distinct.length > 1 || input.strongConflict) return { action: "conflict" };
  if (distinct.length === 1) {
    return { action: "use", instrumentId: distinct[0], attachAlias: true, aliasBootstrap: false };
  }
  // 5. Deterministic weak fallback (ticker + MIC).
  if (input.weakMatchInstrumentId) {
    return { action: "use", instrumentId: input.weakMatchInstrumentId, attachAlias: true, aliasBootstrap: true };
  }
  // 6. Nothing safe to reuse.
  return { action: "create" };
}

// ─── DB-binding wrapper ───────────────────────────────────────────────────────

type Client = PrismaClient | Prisma.TransactionClient;

export interface ResolvedInstrument {
  instrumentId: string;
  created: boolean;
  conflict: boolean;
}

/**
 * Resolve a Plaid Security to a canonical Instrument, creating identity/alias
 * rows as needed. Best-effort callers should wrap in try/catch — this performs
 * writes. Idempotent for a stable security_id (alias hit short-circuits).
 */
export async function resolveInstrumentForPlaidSecurity(
  sec: Security,
  opts?: { client?: Client; financialAccountId?: string | null },
): Promise<ResolvedInstrument> {
  const client = opts?.client ?? db;

  // 1. Provider alias (fast path, deterministic repeats).
  const alias = await client.instrumentAlias.findUnique({
    where: { provider_externalId: { provider: PLAID_PROVIDER, externalId: sec.security_id } },
    select: { instrumentId: true },
  });

  // 2–4. Strong-identifier candidates.
  const strongWhere: Prisma.InstrumentWhereInput[] = [];
  if (sec.cusip) strongWhere.push({ cusip: sec.cusip });
  if (sec.isin) strongWhere.push({ isin: sec.isin });
  if (sec.sedol) strongWhere.push({ sedol: sec.sedol });
  const strongMatches = alias || strongWhere.length === 0
    ? []
    : await client.instrument.findMany({
        where: { OR: strongWhere },
        select: { id: true, cusip: true, isin: true, sedol: true },
      });
  const strongConflict = strongMatches.length === 1 && strongIdsConflict(sec, strongMatches[0]);

  // 5. Weak fallback (ticker + MIC) — only when no alias / strong match.
  let weakMatchId: string | null = null;
  if (!alias && strongMatches.length === 0 && sec.ticker_symbol) {
    const weak = await client.instrument.findFirst({
      where: { tickerSymbol: sec.ticker_symbol, marketIdentifierCode: sec.market_identifier_code ?? null },
      select: { id: true },
    });
    weakMatchId = weak?.id ?? null;
  }

  const decision = decideResolution({
    aliasInstrumentId: alias?.instrumentId ?? null,
    strongMatchInstrumentIds: strongMatches.map((m) => m.id),
    strongConflict,
    weakMatchInstrumentId: weakMatchId,
  });

  if (decision.action === "use") {
    if (decision.attachAlias) {
      await attachAlias(client, decision.instrumentId, sec, decision.aliasBootstrap);
    }
    return { instrumentId: decision.instrumentId, created: false, conflict: false };
  }

  if (decision.action === "conflict") {
    // Refuse the merge — preserve both, create a fresh identity, flag for review.
    await recordSyncIssue({
      kind: "INSTRUMENT_IDENTITY_CONFLICT",
      financialAccountId: opts?.financialAccountId ?? null,
      detail: {
        securityId: sec.security_id,
        ticker: sec.ticker_symbol ?? null,
        cusip: sec.cusip ?? null,
        isin: sec.isin ?? null,
        sedol: sec.sedol ?? null,
        conflictingInstrumentIds: [...new Set(strongMatches.map((m) => m.id))],
      },
    }, client);
    const created = await createInstrumentWithAlias(client, sec, { bootstrap: false });
    return { instrumentId: created, created: true, conflict: true };
  }

  // action === "create"
  const created = await createInstrumentWithAlias(client, sec, { bootstrap: false });
  return { instrumentId: created, created: true, conflict: false };
}

async function attachAlias(client: Client, instrumentId: string, sec: Security, bootstrap: boolean): Promise<void> {
  const metadata: Prisma.InputJsonValue = {
    institutionSecurityId: sec.institution_security_id ?? null,
    proxySecurityId: sec.proxy_security_id ?? null,
    ...(bootstrap ? { bootstrap: true } : {}),
  };
  // Idempotent: the provider/externalId unique guards against a duplicate mapping.
  await client.instrumentAlias.upsert({
    where: { provider_externalId: { provider: PLAID_PROVIDER, externalId: sec.security_id } },
    create: { instrumentId, provider: PLAID_PROVIDER, externalId: sec.security_id, metadata },
    update: {},
  });
}

async function createInstrumentWithAlias(client: Client, sec: Security, opts: { bootstrap: boolean }): Promise<string> {
  const inst = await client.instrument.create({
    data: {
      ...mapPlaidSecurityToInstrument(sec),
      aliases: {
        create: {
          provider: PLAID_PROVIDER,
          externalId: sec.security_id,
          metadata: {
            institutionSecurityId: sec.institution_security_id ?? null,
            proxySecurityId: sec.proxy_security_id ?? null,
            ...(opts.bootstrap ? { bootstrap: true } : {}),
          },
        },
      },
    },
    select: { id: true },
  });
  return inst.id;
}
