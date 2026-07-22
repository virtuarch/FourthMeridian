/**
 * lib/ai/assemblers/accounts.ts
 *
 * AI Context Assembler — 'accounts' domain (D4 Slice 2 + Slice A).
 *
 * Assembles a ContextDomainSection for FinanceDomains.ACCOUNTS containing:
 *   - Financial totals: assets, liabilities, net worth, per-category subtotals
 *   - Per-category counts
 *   - Health summary: sync errors, stale manual accounts, needs-reauth flags
 *   - Debt metadata for FULL-visibility debt accounts (APR, minimum payment,
 *     due day, statement close day, promo APR expiry) — Slice A addition
 *   - Knowledge gaps: list of null debt metadata fields for FULL-visibility
 *     debt accounts — Slice A addition
 *   - Per-account list (omitted when scopeHint='brief')
 *
 * ── Permissions and visibility ───────────────────────────────────────────────
 * All accounts are read via SpaceAccountLink (status: ACTIVE, account not
 * soft-deleted). SpaceAccountLink.visibilityLevel controls what the AI context
 * may include per account:
 *
 *   FULL         — real name, institution, full balance, sync metadata,
 *                  debt metadata (APR, rates, due day, etc.)
 *   BALANCE_ONLY — generic sanitized name, balance only; institution, debt
 *                  metadata, and all identifying fields are withheld (mirroring
 *                  the Space API and normalizeSharedAccounts() behaviour).
 *   SUMMARY_ONLY — treated the same as BALANCE_ONLY for debt metadata.
 *
 * Knowledge gaps are only emitted for FULL-visibility debt accounts. Emitting
 * gaps for BALANCE_ONLY accounts would indirectly reveal their existence as
 * debt accounts, breaking the privacy guarantee.
 *
 * Health checks (error count, stale count, needsReauth count) run across all
 * accounts. For BALANCE_ONLY accounts the count is included but the account
 * name is never exposed — errorAccountNames etc. only list FULL accounts.
 *
 * ── Debt metadata resolution ─────────────────────────────────────────────────
 * Effective APR:            DebtProfile.apr (user) → FinancialAccount.interestRate (provider) → null
 * Effective min. payment:   DebtProfile.minimumPayment (user) → FinancialAccount.minimumPayment (provider) → null
 * rateSource:               'user' when DebtProfile.apr is set; 'provider' when only
 *                           FinancialAccount.interestRate is set; null when both are null.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Queries are always filtered by spaceCtx.spaceId — no cross-Space data.
 * - All data returned is plaintext; no credential fields are selected.
 * - Debt metadata (APR, rates) is only included for VisibilityLevel.FULL accounts.
 */

import { db } from '@/lib/db';
import { ShareStatus, PlaidItemStatus, VisibilityLevel } from '@prisma/client';

import { classifyAccounts, type ClassifiableAccount } from '@/lib/account-classifier';
import { DEFAULT_DISPLAY_CURRENCY } from '@/lib/currency';
import { identityContext, convertMoney, fxDisclosureOf } from '@/lib/money/convert';
import { buildSpaceConversionContext } from '@/lib/money/server-context';
import { yesterdayUTCISO } from '@/lib/fx/config';
import { genericAccountName } from '@/lib/account-privacy';
import { amountOwed, creditBalance, liabilityState } from '@/lib/debt/balance-semantics';
import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  AccountsSectionData,
  AccountSummaryItem,
  AccountHealthSummary,
  KnowledgeGap,
  TrackedAccountLite,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';

// ---------------------------------------------------------------------------
// Internal query result types
// ---------------------------------------------------------------------------

/** Raw shape returned by the Prisma select on SpaceAccountLink. */
type AccountLinkRow = {
  visibilityLevel: VisibilityLevel;
  // OPS-2 S5 — nullable since SpaceAccountLink.addedByUserId flipped to
  // SetNull: a link whose adder's account was deleted has a null adder.
  addedByUserId:   string | null;
  addedByUser:     { firstName: string | null; name: string | null } | null;
  financialAccount: {
    id:              string;
    name:            string;
    displayName:     string | null;
    officialName:    string | null;
    plaidName:       string | null;
    type:            string;
    institution:     string;
    mask:            string | null;
    balance:         number;
    currency:        string;
    lastUpdated:          Date;
    balanceLastUpdatedAt: Date | null;
    syncStatus:   string | null;
    debtSubtype:     string | null;
    // Flat fallback debt fields (provider-sourced or legacy)
    interestRate:    number | null;   // FinancialAccount.interestRate — provider APR fallback
    minimumPayment:  number | null;   // FinancialAccount.minimumPayment — provider min-payment fallback
    // DebtProfile: user-entered debt metadata (1:1, optional)
    debtProfile: {
      apr:               number | null;
      minimumPayment:    number | null;
      dueDay:            number | null;
      statementCloseDay: number | null;
      promoAprEndDate:   Date | null;
      updatedAt:         Date;
    } | null;
    connections:  Array<{
      connectedByUserId: string;
      plaidItem:         { status: PlaidItemStatus } | null;
    }>;
  };
};

// ---------------------------------------------------------------------------
// Assembler implementation
// ---------------------------------------------------------------------------

async function assembleAccounts(
  spaceCtx: SpaceContext,
  options:  AssemblerOptions,
): Promise<ContextDomainSection | null> {
  const { spaceId, userId } = spaceCtx;
  const { scopeHint = 'full' } = options;
  const assembledAt = new Date().toISOString();

  // ── Query ─────────────────────────────────────────────────────────────────
  // Always filtered to this Space via spaceId. kind (HOME vs SHARED) is not
  // filtered — both confer visibility, matching all other D3 Step 4 cutover
  // points. Soft-deleted accounts (deletedAt non-null) are excluded.

  const links: AccountLinkRow[] = await db.spaceAccountLink.findMany({
    where: {
      spaceId,
      status:           ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null },
    },
    select: {
      visibilityLevel: true,
      addedByUserId:   true,
      addedByUser: {
        select: { firstName: true, name: true },
      },
      financialAccount: {
        select: {
          id:             true,
          name:           true,
          displayName:    true,
          officialName:   true,
          plaidName:      true,
          type:           true,
          institution:    true,
          mask:           true,
          balance:        true,
          currency:       true,
          lastUpdated:          true,
          balanceLastUpdatedAt: true,
          syncStatus:     true,
          debtSubtype:    true,
          // Flat fallback debt fields — provider-sourced or legacy
          interestRate:   true,
          minimumPayment: true,
          // DebtProfile — user-entered debt metadata (1:1 optional relation)
          debtProfile: {
            select: {
              apr:               true,
              minimumPayment:    true,
              dueDay:            true,
              statementCloseDay: true,
              promoAprEndDate:   true,
              updatedAt:         true,
            },
          },
          // For needsReauth check: only the current user's own Plaid connections.
          // We look at whether any of their connections has a NEEDS_REAUTH item.
          // No credential fields are selected — PlaidItem.status is plaintext.
          connections: {
            where: {
              deletedAt:     null,
              plaidItemDbId: { not: null },
            },
            select: {
              connectedByUserId: true,
              plaidItem: { select: { status: true } },
            },
          },
        },
      },
    },
    orderBy: [
      { financialAccount: { type: 'asc' } },
      { financialAccount: { name: 'asc' } },
    ],
  });

  // No accounts visible — return null so the domain is noted as empty.
  if (links.length === 0) return null;

  const now = new Date();

  // ── Classify ──────────────────────────────────────────────────────────────
  // classifyAccounts() needs only { type, balance } — available regardless of
  // visibility level, so all accounts contribute to totals. currency rides
  // along for the MC1 conversion seam (identical totals under identity).

  const classifiableAll: ClassifiableAccount[] = links.map((l) => ({
    type:       l.financialAccount.type,
    balance:    l.financialAccount.balance,
    currency:   l.financialAccount.currency,
    syncStatus: l.financialAccount.syncStatus ?? undefined,
  }));

  // MC1 Phase 3 Slice 4 — THE AI FLIP (plan seam #3). Totals convert at the
  // latest close into the Space's reporting currency; per-account rows keep
  // native currency (already in the payload). All-USD Spaces are numerically
  // identical to the Phase 2 identity behavior (equivalence gates). Identity
  // fallback only if the Space row vanished mid-request. Data-only: no
  // prompt/serializer change (presentation is Phase 4).
  const space = await db.space.findUnique({
    where:  { id: spaceId },
    select: { reportingCurrency: true },
  });
  const moneyCtx = space
    ? await buildSpaceConversionContext(space, {
        currencies: classifiableAll.map((a) => a.currency ?? null),
        dates:      [yesterdayUTCISO()],
      })
    : identityContext(DEFAULT_DISPLAY_CURRENCY);
  const classification = classifyAccounts(classifiableAll, moneyCtx);

  // P2-7D — per-account reporting-currency balance. Uses the SAME moneyCtx and
  // valuation date (latest close) classifyAccounts uses for the totals above, so a
  // per-account reportingBalance and the section totals reconcile exactly.
  // Native `balance`/`currency` are preserved on each item for account-detail
  // display; reportingBalance is the cross-account comparison/weighting/ranking
  // value (FINANCIAL_SEMANTIC_AUTHORITIES reporting-currency invariant). Missing
  // FX degrades to the native amount + estimated taint (P2-7C conversion contract).
  const valuationDateISO = yesterdayUTCISO();
  const toReporting = (fa: { balance: number; currency: string }): { reportingBalance: number | null; estimated: boolean; unavailable: boolean } => {
    const c = convertMoney({ amount: fa.balance, currency: fa.currency }, valuationDateISO, moneyCtx);
    // V25-FINAL-1 — an unavailable known-currency balance has NO reporting value:
    // reportingBalance is null (never a fake 0), so the AI reads the native balance
    // and the `unavailable` flag, and can never treat it as "worth 0".
    return { reportingBalance: c.amount, estimated: c.estimated, unavailable: c.amount === null };
  };

  // ── Health summary ────────────────────────────────────────────────────────

  let errorCount       = 0;
  let staleCount       = 0;
  let needsReauthCount = 0;
  const errorAccountNames:       string[] = [];
  const staleAccountNames:       string[] = [];
  const needsReauthAccountNames: string[] = [];

  for (const link of links) {
    const fa          = link.financialAccount;
    const isFullView  = link.visibilityLevel === VisibilityLevel.FULL;

    // Sync error
    if (fa.syncStatus === 'error') {
      errorCount++;
      if (isFullView) {
        errorAccountNames.push(resolveDisplayName(fa));
      }
    }

    // Stale manual asset (not updated in 30+ days)
    if (fa.syncStatus === 'manual') {
      const daysSince = (now.getTime() - fa.lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince > 30) {
        staleCount++;
        if (isFullView) {
          staleAccountNames.push(resolveDisplayName(fa));
        }
      }
    }

    // Needs re-authentication (current user's own Plaid connection only)
    const reauthConn = fa.connections.find(
      (c) =>
        c.connectedByUserId === userId &&
        c.plaidItem?.status === PlaidItemStatus.NEEDS_REAUTH,
    );
    if (reauthConn) {
      needsReauthCount++;
      if (isFullView) {
        needsReauthAccountNames.push(resolveDisplayName(fa));
      }
    }
  }

  const health: AccountHealthSummary = {
    errorCount,
    staleCount,
    needsReauthCount,
    errorAccountNames,
    staleAccountNames,
    needsReauthAccountNames,
  };

  // ── Knowledge gaps ────────────────────────────────────────────────────────
  // Computed for FULL-visibility debt accounts only. BALANCE_ONLY and
  // SUMMARY_ONLY accounts are excluded — surfacing gaps for them would
  // implicitly reveal that they are debt accounts, breaking the privacy
  // guarantee enforced by the BALANCE_ONLY visibility tier.

  const knowledgeGaps: KnowledgeGap[] = [];

  for (const link of links) {
    const fa = link.financialAccount;
    if (fa.type !== 'debt') continue;
    if (link.visibilityLevel !== VisibilityLevel.FULL) continue;

    const displayName = resolveDisplayName(fa);
    const effectiveApr = fa.debtProfile?.apr ?? fa.interestRate ?? null;
    const effectiveMinPayment = fa.debtProfile?.minimumPayment ?? fa.minimumPayment ?? null;

    if (effectiveApr === null) {
      knowledgeGaps.push({
        accountId:   fa.id,
        accountName: displayName,
        field:       'apr',
        label:       resolveRateLabel(fa.debtSubtype),
        debtSubtype: fa.debtSubtype,
      });
    }

    if (effectiveMinPayment === null) {
      knowledgeGaps.push({
        accountId:   fa.id,
        accountName: displayName,
        field:       'minimumPayment',
        label:       'Minimum Payment',
        debtSubtype: fa.debtSubtype,
      });
    }
  }

  // ── Per-account summaries ─────────────────────────────────────────────────
  // Omitted entirely when scopeHint='brief' to reduce payload for the Daily
  // Brief aggregator (which only needs totals + health to compose insights).

  let accounts: AccountSummaryItem[] | undefined;

  if (scopeHint !== 'brief') {
    accounts = links.map((link): AccountSummaryItem => {
      const fa         = link.financialAccount;
      const isFull     = link.visibilityLevel === VisibilityLevel.FULL;
      const ownerName  = link.addedByUser?.firstName?.trim() ||
                         link.addedByUser?.name?.trim().split(' ')[0] ||
                         null;

      const needsReauth = fa.connections.some(
        (c) =>
          c.connectedByUserId === userId &&
          c.plaidItem?.status === PlaidItemStatus.NEEDS_REAUTH,
      );

      const rep = toReporting(fa);

      // V25-SIDE-1 — derived liability semantics, so the model never has to infer
      // what a negative credit-card balance means. Native currency (same basis as
      // `balance`); emitted at every visibility level for debt rows, since they
      // only restate a balance the row already carries.
      const liability = fa.type === 'debt'
        ? {
            amountOwed:     amountOwed(fa.balance),
            creditBalance:  creditBalance(fa.balance),
            liabilityState: liabilityState(fa.balance),
          }
        : {};

      if (isFull) {
        const base: AccountSummaryItem = {
          id:              fa.id,
          name:            resolveDisplayName(fa),
          type:            fa.type,
          institution:     fa.institution,
          balance:         fa.balance,
          currency:        fa.currency,
          reportingBalance: rep.reportingBalance,
          ...(rep.estimated ? { reportingBalanceEstimated: true } : {}),
          ...(rep.unavailable ? { reportingBalanceUnavailable: true } : {}),
          lastUpdated:          fa.lastUpdated.toISOString(),
          balanceLastUpdatedAt: fa.balanceLastUpdatedAt?.toISOString() ?? null,
          syncStatus:      fa.syncStatus,
          needsReauth,
          visibilityLevel: 'FULL',
          ...liability,
        };

        // Debt metadata — FULL visibility, debt-type accounts only.
        // Effective resolution: DebtProfile (user) → FinancialAccount flat (provider) → null.
        if (fa.type === 'debt') {
          const dp = fa.debtProfile;
          const effectiveApr        = dp?.apr        ?? fa.interestRate   ?? null;
          const effectiveMinPayment = dp?.minimumPayment ?? fa.minimumPayment ?? null;

          // rateSource reflects where the effective APR originated.
          const rateSource: 'user' | 'provider' | null =
            dp?.apr        != null ? 'user'     :
            fa.interestRate != null ? 'provider' :
            null;

          base.apr                  = effectiveApr;
          base.minimumPayment       = effectiveMinPayment;
          base.rateSource           = rateSource;
          base.dueDay               = dp?.dueDay            ?? null;
          base.statementCloseDay    = dp?.statementCloseDay ?? null;
          base.promoAprEndDate      = dp?.promoAprEndDate
            ? dp.promoAprEndDate.toISOString().split('T')[0]
            : null;
          base.debtProfileUpdatedAt = dp ? dp.updatedAt.toISOString() : null;
        }

        return base;
      }

      // BALANCE_ONLY — sanitized, no institution, no debt metadata
      return {
        id:              `balance-only:${link.addedByUserId}:${fa.type}:${fa.currency}`,
        name:            genericAccountName({
                           type:           fa.type,
                           debtSubtype:    fa.debtSubtype,
                           ownerFirstName: ownerName,
                         }),
        type:            fa.type,
        balance:         fa.balance,
        currency:        fa.currency,
        reportingBalance: rep.reportingBalance,
        ...(rep.estimated ? { reportingBalanceEstimated: true } : {}),
        ...(rep.unavailable ? { reportingBalanceUnavailable: true } : {}),
        lastUpdated:          fa.lastUpdated.toISOString(),
        balanceLastUpdatedAt: fa.balanceLastUpdatedAt?.toISOString() ?? null,
        syncStatus:      fa.syncStatus,
        needsReauth,
        visibilityLevel: 'BALANCE_ONLY',
        ...liability,
        // Debt metadata intentionally omitted — BALANCE_ONLY privacy guarantee.
        // The liability semantics above are NOT debt metadata: they restate the
        // balance this tier already discloses, adding no new exposure.
      };
    });
  }

  // ── Assemble payload ──────────────────────────────────────────────────────

  // Distinct FinancialAccount ids visible in this Space. Populated regardless of
  // scopeHint so the Daily Brief can deduplicate accounts shared across Spaces.
  // IDs only — no balances or names — so this adds no privacy exposure and does
  // not affect the BALANCE_ONLY visibility guarantee.
  const accountIds = links.map((l) => l.financialAccount.id);

  // Privacy-safe identity roster for the Daily Brief "Accounts Tracked" list.
  // Populated in all scopes. NEVER includes balances. Visibility handling mirrors
  // the per-account `accounts` array: FULL exposes real name + institution + mask;
  // all other levels use a generic name and omit institution/mask. SUMMARY_ONLY is
  // surfaced distinctly so downstream dedup can apply FULL > BALANCE_ONLY >
  // SUMMARY_ONLY precedence; every other non-FULL level is treated as BALANCE_ONLY.
  const trackedAccounts: TrackedAccountLite[] = links.map((link) => {
    const fa       = link.financialAccount;
    const isFull   = link.visibilityLevel === VisibilityLevel.FULL;
    const ownerName = link.addedByUser?.firstName?.trim() ||
                      link.addedByUser?.name?.trim().split(' ')[0] ||
                      null;

    if (isFull) {
      return {
        id:          fa.id,
        name:        resolveDisplayName(fa),
        type:        fa.type,
        subtype:     fa.debtSubtype,
        institution: fa.institution,
        mask:        fa.mask,
        visibility:  'FULL',
      };
    }

    const visibility: TrackedAccountLite['visibility'] =
      link.visibilityLevel === VisibilityLevel.SUMMARY_ONLY ? 'SUMMARY_ONLY' : 'BALANCE_ONLY';

    // BALANCE_ONLY / SUMMARY_ONLY — generic name, no institution, no mask.
    return {
      id:         fa.id,
      name:       genericAccountName({
                    type:           fa.type,
                    debtSubtype:    fa.debtSubtype,
                    ownerFirstName: ownerName,
                  }),
      type:       fa.type,
      subtype:    null,
      visibility,
    };
  });

  const data: AccountsSectionData = {
    totalCount:         links.length,
    accountIds,
    trackedAccounts,
    totalAssets:        classification.totalAssets,
    totalLiabilities:   classification.totalLiabilities,
    netWorth:           classification.netWorth,
    totalLiquid:        classification.totalLiquid,
    totalInvestments:   classification.totalInvestments,
    totalDigitalAssets: classification.totalDigitalAssets,
    totalRealAssets:    classification.totalRealAssets,
    totalsEstimated:    classification.estimated, // MC1 P3 Slice 4 (D-7) — data-only
    totalsUnconverted:  classification.unconverted, // V25-FINAL-1 — a balance was excluded (no rate)

    counts: {
      liquid:        classification.liquid.length,
      investments:   classification.investments.length,
      digitalAssets: classification.digitalAssets.length,
      realAssets:    classification.realAssets.length,
      liabilities:   classification.liabilities.length,
    },
    health,
    knowledgeGaps,
    ...(accounts !== undefined ? { accounts } : {}),
  };

  return {
    domain:      FinanceDomains.ACCOUNTS,
    assembledAt,
    data,
  };
}

// ---------------------------------------------------------------------------
// Display name resolution (FULL visibility only)
// ---------------------------------------------------------------------------

/**
 * Resolve the best display name for a FinancialAccount, mirroring the
 * priority order used in lib/data/accounts.ts:
 *   displayName ?? officialName ?? plaidName ?? name
 */
function resolveDisplayName(fa: {
  name:         string;
  displayName:  string | null;
  officialName: string | null;
  plaidName:    string | null;
}): string {
  return fa.displayName ?? fa.officialName ?? fa.plaidName ?? fa.name;
}

/**
 * Resolve the human-readable label for the APR/rate field based on
 * the account's debtSubtype. Produces contextual labels so that the AI
 * (and future UI) can say "Mortgage Rate" instead of "APR" for a mortgage,
 * "Auto Loan Rate" for an auto loan, etc.
 */
function resolveRateLabel(debtSubtype: string | null | undefined): string {
  switch (debtSubtype) {
    case 'mortgage':       return 'Mortgage Rate';
    case 'auto_loan':      return 'Auto Loan Rate';
    case 'student_loan':   return 'Student Loan Rate';
    case 'personal_loan':  return 'Personal Loan Rate';
    case 'heloc':          return 'HELOC Rate';
    case 'credit_card':
    case 'line_of_credit':
    default:               return 'APR';
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.ACCOUNTS, assembleAccounts);
