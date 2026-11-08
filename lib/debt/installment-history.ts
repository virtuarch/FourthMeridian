/**
 * lib/debt/installment-history.ts — Mortgage F1b (S2 D2)
 *
 * Did a Space EVER hold an installment liability (mortgage, auto, student, …)?
 * Decides only how LEGACY snapshot rows (installmentDebt NULL) are PRESENTED on
 * the Liquid NW chart: a Space that never held one has nothing the old
 * definition subtracted that the new one does not, so its legacy rows plot as
 * the current definition (one joined series, no marker). Basis itself stays the
 * pure per-row rule in lib/debt/liquid-net-worth.ts.
 *
 * EVERY link counts — ACTIVE, REVOKED, any status — and the account is read
 * whether or not it is soft-deleted (`deletedAt`): a removed mortgage still
 * shaped the history. No status / deletedAt filter is applied, on purpose.
 */

import { everHeldInstallmentLiability } from "@/lib/debt/liquid-net-worth";

/** The minimal client surface this reads (a Prisma client or tx). */
export interface InstallmentHistoryClient {
  spaceAccountLink: {
    findMany(args: {
      where: { spaceId: string };
      select: { financialAccount: { select: { type: true; debtSubtype: true; providerSubtype: true; creditLimit: true } } };
    }): Promise<Array<{ financialAccount: { type: string; debtSubtype: string | null; providerSubtype: string | null; creditLimit: number | null } | null }>>;
  };
}

export async function spaceEverHeldInstallmentLiability(client: InstallmentHistoryClient, spaceId: string): Promise<boolean> {
  const links = await client.spaceAccountLink.findMany({
    where:  { spaceId },
    select: { financialAccount: { select: { type: true, debtSubtype: true, providerSubtype: true, creditLimit: true } } },
  });
  return everHeldInstallmentLiability(links.flatMap((l) => (l.financialAccount ? [l.financialAccount] : [])));
}
