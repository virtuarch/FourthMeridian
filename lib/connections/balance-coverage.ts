/**
 * lib/connections/balance-coverage.ts  (PB-8)
 *
 * The read behind balance-coverage.core.ts. Same traversal as
 * valuation-coverage.ts (SpaceAccountLink ACTIVE → live FinancialAccount),
 * limited to links that disclose a balance, then THE coverage authority
 * (getAccountCoverage — the call getAccountBalancesOverWindow makes) for each
 * account's display floor. Read-only; dates and counts only leave.
 */

import "server-only";
import { AccountType, ShareStatus, SpaceType } from "@prisma/client";
import type { ReadClient } from "@/lib/db/tenant-context";
import { grantsBalanceDisclosure } from "@/lib/account-privacy";
import { getAccountCoverage } from "@/lib/data/account-coverage";
import { coverageClassFor } from "@/lib/data/account-coverage.core";
import { isReconstructableCard, isoDate, maxDate, truncDateUTC } from "@/lib/snapshots/backfill-core";
import { balanceCoverageSideOf, deriveBalanceCoverage, writerAlignedFloorISO, type BalanceCoverage, type BalanceCoverageAccountInput } from "./balance-coverage.core";

export async function loadBalanceCoverage(client: ReadClient, spaceId: string): Promise<BalanceCoverage | null> {
  const space = await client.space.findUnique({ where: { id: spaceId }, select: { type: true } });
  const isShared = space?.type === SpaceType.SHARED;
  const links = await client.spaceAccountLink.findMany({
    where: {
      spaceId, status: ShareStatus.ACTIVE,
      financialAccount: { deletedAt: null, type: { in: [AccountType.checking, AccountType.savings, AccountType.debt] } },
    },
    select: {
      createdAt: true, visibilityLevel: true,
      financialAccount: { select: { id: true, type: true, balance: true, createdAt: true, debtSubtype: true, creditLimit: true, providerSubtype: true } },
    },
  });
  const disclosed = links.filter((l) => grantsBalanceDisclosure(l.visibilityLevel));
  if (!disclosed.length) return null;

  const refs = disclosed.map((l) => ({
    id: l.financialAccount.id,
    type: l.financialAccount.type as string,
    reconstructableCard: isReconstructableCard({
      type: l.financialAccount.type as string,
      debtSubtype: l.financialAccount.debtSubtype,
      creditLimit: l.financialAccount.creditLimit,
      providerSubtype: l.financialAccount.providerSubtype,
    }),
    connectionFloorISO: isoDate(maxDate(truncDateUTC(l.financialAccount.createdAt), truncDateUTC(l.createdAt))),
  }));
  const coverage = await getAccountCoverage(client, refs);

  const inputs: BalanceCoverageAccountInput[] = [];
  disclosed.forEach((l, i) => {
    const side = balanceCoverageSideOf(refs[i].type);
    const cov = coverage.get(refs[i].id);
    if (!side || !cov) return;
    const coverageClass = coverageClassFor(refs[i].type, refs[i].reconstructableCard);
    inputs.push({
      side,
      coverageClass,
      floorISO: writerAlignedFloorISO(cov, coverageClass, refs[i].connectionFloorISO, isoDate(truncDateUTC(l.createdAt)), isShared),
      balance: l.financialAccount.balance,
    });
  });
  return deriveBalanceCoverage(inputs);
}
