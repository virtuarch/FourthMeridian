/**
 * lib/ai/assemblers/accounts.ts
 *
 * AI Context Assembler — 'accounts' domain (D4 Slice 2).
 *
 * Assembles a ContextDomainSection for FinanceDomains.ACCOUNTS containing:
 *   - Financial totals: assets, liabilities, net worth, per-category subtotals
 *   - Per-category counts
 *   - Health summary: sync errors, stale manual accounts, needs-reauth flags
 *   - Per-account list (omitted when scopeHint='brief')
 *
 * ── Permissions and visibility ───────────────────────────────────────────────
 * All accounts are read via SpaceAccountLink (status: ACTIVE, account not
 * soft-deleted). SpaceAccountLink.visibilityLevel controls what the AI context
 * may include per account:
 *
 *   FULL         — real name, institution, full balance, sync metadata
 *   BALANCE_ONLY — generic sanitized name, balance only; institution and
 *                  identifying fields are withheld (mirroring the Space API
 *                  and normalizeSharedAccounts() behaviour).
 *
 * Health checks (error count, stale count, needsReauth count) run across all
 * accounts. For BALANCE_ONLY accounts the count is included but the account
 * name is never exposed — errorAccountNames etc. only list FULL accounts.
 *
 * ── Security invariants ──────────────────────────────────────────────────────
 * - Does NOT import lib/plaid/encryption or call any decrypt function.
 * - Does NOT query WorkspaceAccountShare.
 * - Queries are always filtered by spaceCtx.spaceId — no cross-Space data.
 * - All data returned is plaintext; no credential fields are selected.
 */

import { db } from '@/lib/db';
import { ShareStatus, PlaidItemStatus, VisibilityLevel } from '@prisma/client';

import { classifyAccounts, type ClassifiableAccount } from '@/lib/account-classifier';
import { genericAccountName } from '@/lib/account-privacy';
import { registerAssembler } from '@/lib/ai/assembler-registry';
import { FinanceDomains } from '@/lib/ai/types';
import type {
  AssemblerOptions,
  ContextDomainSection,
  AccountsSectionData,
  AccountSummaryItem,
  AccountHealthSummary,
} from '@/lib/ai/types';
import type { SpaceContext } from '@/lib/space';

// ---------------------------------------------------------------------------
// Internal query result types
// ---------------------------------------------------------------------------

/** Raw shape returned by the Prisma select on SpaceAccountLink. */
type AccountLinkRow = {
  visibilityLevel: VisibilityLevel;
  addedByUserId:   string;
  addedByUser:     { firstName: string | null; name: string | null };
  financialAccount: {
    id:           string;
    name:         string;
    displayName:  string | null;
    officialName: string | null;
    plaidName:    string | null;
    type:         string;
    institution:  string;
    balance:      number;
    currency:     string;
    lastUpdated:  Date;
    syncStatus:   string | null;
    debtSubtype:  string | null;
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
          id:          true,
          name:        true,
          displayName: true,
          officialName: true,
          plaidName:   true,
          type:        true,
          institution: true,
          balance:     true,
          currency:    true,
          lastUpdated: true,
          syncStatus:  true,
          debtSubtype: true,
          // For needsReauth check: only the current user's own Plaid connections.
          // We look at whether any of their connections has a NEEDS_REAUTH item.
          // No credential fields are selected — PlaidItem.status is plaintext.
          connections: {
            where: {
              deletedAt:    null,
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
  // visibility level, so all accounts contribute to totals.

  const classifiableAll: ClassifiableAccount[] = links.map((l) => ({
    type:       l.financialAccount.type,
    balance:    l.financialAccount.balance,
    syncStatus: l.financialAccount.syncStatus ?? undefined,
  }));

  const classification = classifyAccounts(classifiableAll);

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

  // ── Per-account summaries ─────────────────────────────────────────────────
  // Omitted entirely when scopeHint='brief' to reduce payload for the Daily
  // Brief aggregator (which only needs totals + health to compose insights).

  let accounts: AccountSummaryItem[] | undefined;

  if (scopeHint !== 'brief') {
    accounts = links.map((link): AccountSummaryItem => {
      const fa         = link.financialAccount;
      const isFull     = link.visibilityLevel === VisibilityLevel.FULL;
      const ownerName  = link.addedByUser.firstName?.trim() ||
                         link.addedByUser.name?.trim().split(' ')[0] ||
                         null;

      const needsReauth = fa.connections.some(
        (c) =>
          c.connectedByUserId === userId &&
          c.plaidItem?.status === PlaidItemStatus.NEEDS_REAUTH,
      );

      if (isFull) {
        return {
          id:              fa.id,
          name:            resolveDisplayName(fa),
          type:            fa.type,
          institution:     fa.institution,
          balance:         fa.balance,
          currency:        fa.currency,
          lastUpdated:     fa.lastUpdated.toISOString(),
          syncStatus:      fa.syncStatus,
          needsReauth,
          visibilityLevel: 'FULL',
        };
      }

      // BALANCE_ONLY — sanitized, no institution or real name
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
        lastUpdated:     fa.lastUpdated.toISOString(),
        syncStatus:      fa.syncStatus,
        needsReauth,
        visibilityLevel: 'BALANCE_ONLY',
      };
    });
  }

  // ── Assemble payload ──────────────────────────────────────────────────────

  const data: AccountsSectionData = {
    totalCount:         links.length,
    totalAssets:        classification.totalAssets,
    totalLiabilities:   classification.totalLiabilities,
    netWorth:           classification.netWorth,
    totalLiquid:        classification.totalLiquid,
    totalInvestments:   classification.totalInvestments,
    totalDigitalAssets: classification.totalDigitalAssets,
    totalRealAssets:    classification.totalRealAssets,
    counts: {
      liquid:       classification.liquid.length,
      investments:  classification.investments.length,
      digitalAssets: classification.digitalAssets.length,
      realAssets:   classification.realAssets.length,
      liabilities:  classification.liabilities.length,
    },
    health,
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

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerAssembler(FinanceDomains.ACCOUNTS, assembleAccounts);
