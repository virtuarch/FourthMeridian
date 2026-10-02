import { DebtClient } from "@/components/dashboard/DebtClient";
import { getFicoData, getAccounts } from "@/lib/data/accounts";
import { getDebtTransactions, getDebtPaymentRows } from "@/lib/data/transactions";
import { getSpaceContext } from "@/lib/space";
import { withTenantDb } from "@/lib/db/tenant-context";
import { resolveEffectiveSpaceConversionSerialized } from "@/lib/money/server-context";
import { yesterdayUTCISO } from "@/lib/fx/config";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function CreditPage() {
  const ctx = await getSpaceContext();
  // RLS-C-S2 — these reads execute as the TENANT, inside ONE short transaction,
  // with the identity taken from server-side session state (getSpaceContext,
  // which is next-auth-backed) and never from a cookie, query string or header.
  // They are pure reads over one Space's accounts, the viewer's own credit score
  // and that Space's debt-account activity, with no network or model call between
  // them, so there is nothing a transaction must not be held across.
  //
  // RLS-T1a — `getDebtPaymentRows` has JOINED the boundary. RLS-T1 left it
  // outside and said why: it was the one read in lib/data/transactions.ts still
  // on the migration principal, because a second caller sat in `lib/ai/**` and a
  // required parameter cannot be added without editing every caller. That second
  // caller was dead code and is gone, so all four reads this page makes are now
  // one short tenant phase under the viewer's own identity.
  const { score, updatedAt, accounts, debtTxns, paymentTxns } = await withTenantDb(ctx.userId, async (tx) => {
    const [fico, accts, debt, pay] = await Promise.all([
      getFicoData(tx, { userId: ctx.userId }),
      // RLS-C-S1 fix — `ctx.userId` was in scope and was not forwarded, so this
      // call took `getAccounts`' ambient branch and re-resolved the viewer
      // inside the leaf. Same value, now stated by the caller.
      getAccounts(tx, { spaceId: ctx.spaceId, userId: ctx.userId }),
      getDebtTransactions(tx, { spaceId: ctx.spaceId }), // TX-2 bounded (default cap)
      // v2.6-TRUTH-7 — the debt-payment authority counts the CASH leg, which lives
      // on the account the money LEFT. A liability-scoped read cannot see it.
      getDebtPaymentRows(tx, { spaceId: ctx.spaceId }),
    ]);
    return { score: fico.score, updatedAt: fico.updatedAt, accounts: accts, debtTxns: debt, paymentTxns: pay };
  });
  const transactions = debtTxns.rows;

  const debtAccounts = accounts.filter((a) => a.type === "debt");
  // Every account, for the tier resolver the authority needs — NOT for display.
  const accountTiers = accounts.map((a) => ({ id: a.id, type: a.type }));

  // MC1 Phase 3 Slice 6 (F-1, D-6) — serialized conversion context for the
  // client-side per-liability rollup (each debt leg converts at its own row
  // date). All-USD Spaces serialize empty entries; math is identical.
  //
  // REVIEW-3 B-5 (E5) — resolved through the EFFECTIVE-currency decision point
  // (V25-CLOSE-3A), not the raw requested one: when the Space's requested
  // currency is wholly unsatisfiable the context targets USD, matching the
  // reverted label the shell layout provides, instead of a context whose every
  // conversion misses under a label the page still claims. All-USD Spaces are
  // satisfiable by construction — behaviour unchanged.
  const { moneyCtx } = await resolveEffectiveSpaceConversionSerialized(ctx.space, {
    currencies: [
      ...debtAccounts.map((a) => a.currency ?? null),
      ...transactions.map((t) => t.currency ?? null),
      ...paymentTxns.rows.map((t) => t.currency ?? null),
    ],
    dates: [yesterdayUTCISO(), ...transactions.map((t) => t.date), ...paymentTxns.rows.map((t) => t.date)],
  });

  return (
    <DebtClient
      initialFico={score}
      lastUpdatedAt={updatedAt}
      accounts={debtAccounts}
      transactions={transactions}
      paymentRows={paymentTxns.rows}
      accountTiers={accountTiers}
      moneyCtx={moneyCtx}
    />
  );
}
