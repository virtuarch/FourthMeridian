/**
 * lib/crypto/wallet-current-value.ts
 *
 * W-M3a — THE current value of a wallet whose chain writes no balance column.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────────
 * Since W-M1c, a native wallet adapter writes its evidence to the position
 * spine and deliberately does NOT write `FinancialAccount.balance` or
 * `.nativeBalance` (`netWorthParticipation: "WITHHELD_PENDING_CONVERGENCE"`).
 * That was the right call — those columns are an undated sync-time USD figure,
 * and a chain should not be forced to fabricate one to be visible.
 *
 * But the account read path composes every displayed balance FROM those
 * columns, and they are `NOT NULL DEFAULT 0`. So a Solana wallet holding a
 * verified 0.751600602 SOL rendered as $0.00 on every account surface, while
 * the Investments workspace — which reads the spine — showed it correctly. Two
 * chains of custody for one number, disagreeing.
 *
 * A column that cannot express "withheld" reported withheld AS ZERO. That is
 * the single failure this module exists to prevent, and it is why the shape
 * below is tri-state rather than a number.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * It is NOT a second valuation authority. It performs no price lookup, no FX,
 * no staleness policy and no arithmetic of its own: rows go to
 * `valuePositionRows` — the same canonical path the Investments Time Machine
 * and `getCurrentPositions` use — and what comes back is reported. If this
 * module and the Investments workspace ever disagreed about what a wallet is
 * worth, that would be a defect in this file.
 *
 * It is also NOT a visibility authority. It takes account ids the caller has
 * ALREADY authorized and answers only about those. That is deliberate: a
 * BALANCE_ONLY-shared account's *balance* is shared (only per-item detail is
 * not), so the account read path — which resolves that boundary itself — is
 * the right place for the decision, and `getCurrentPositions` (hard-wired to
 * FULL-only detail) is deliberately NOT reused here. Reusing it would have
 * silently zeroed every BALANCE_ONLY-shared wallet, re-creating this exact bug
 * one visibility tier down.
 *
 * ── BTC IS UNTOUCHED ────────────────────────────────────────────────────────
 * Chains that DO write the legacy column (`feedsLegacyWealthHistory`) are
 * skipped entirely and keep composing from it, byte-identically. This module
 * fills a gap; it does not migrate anyone out of the column. That migration is
 * the wallet net-worth convergence, and it is not this.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  POSITION_VALUATION_SELECT,
  RECONSTRUCTION_VALUATION_SELECT,
  valuePositionRows,
} from "@/lib/investments/valuation";
import { todayUTCISO } from "@/lib/time/clock";
import { feedsLegacyWealthHistory } from "./wallet-sync-dispatch";
import { nativeAssetForChain } from "./native-asset";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Why a wallet has, or does not have, a current value.
 *
 * These are three DIFFERENT facts and no consumer may collapse them:
 *
 *   VALUED          the spine holds an observation and the canonical price path
 *                   priced it. `quantity` and `value` are both real.
 *   NO_PRICE        we know exactly how much is held and cannot say what it is
 *                   worth. `quantity` is real; `value` is null. A held asset,
 *                   not an empty one.
 *   NO_OBSERVATION  nothing has ever been observed for this wallet — never
 *                   synced, or every attempt refused. Both are null.
 *
 * A CONFIRMED ZERO is not on this list, and that is the point: a provider that
 * returns a zero balance produces a real observation, so it arrives as VALUED
 * with `quantity: 0`. "Holds nothing" and "we don't know" are distinguishable
 * downstream because one is a number and the other is null.
 */
export type WalletValueState = "VALUED" | "NO_PRICE" | "NO_OBSERVATION";

export interface WalletCurrentValue {
  accountId:  string;
  chain:      string;
  /** CAIP-19 identity of the native asset, or null for an unregistered chain. */
  assetKey:   string | null;
  /** Display ticker — never an identity. */
  symbol:     string | null;
  /** Native units held. NULL IS UNKNOWN — never 0. A real zero is 0. */
  quantity:   number | null;
  /** Reporting-currency value. NULL IS UNKNOWN — never 0. */
  value:      number | null;
  state:      WalletValueState;
  /** The date this was valued at (the caller's clock). */
  asOf:       string;
  /** The close actually used, which may be earlier than `asOf`. */
  priceDate:  string | null;
}

/** One account the caller has already authorized, with the chain that names its asset. */
export interface WalletAccountRef {
  id:          string;
  walletChain: string | null | undefined;
}

/**
 * Does this account's value have to come from the spine?
 *
 * True only for a wallet on a chain that writes no legacy balance column. Every
 * other account — cash, credit, brokerage, and BTC — is unaffected and keeps
 * whatever authority it already had.
 */
export function needsSpineValuation(ref: WalletAccountRef): boolean {
  return Boolean(ref.walletChain) && !feedsLegacyWealthHistory(ref.walletChain);
}

/**
 * Current value per account for the wallets that need it, keyed by account id.
 *
 * Accounts that do not need spine valuation are ABSENT from the map rather than
 * present with a zero — the caller must fall through to its existing authority
 * for those, and an absent key cannot be mistaken for "worth nothing".
 */
export async function loadWalletCurrentValues(
  refs: readonly WalletAccountRef[],
  options?: { client?: Client; asOf?: string; contextSpaceId?: string | null; reportingCurrency?: string },
): Promise<Map<string, WalletCurrentValue>> {
  const out = new Map<string, WalletCurrentValue>();
  const client = options?.client ?? db;
  const asOf   = options?.asOf ?? todayUTCISO();

  const wallets = refs.filter(needsSpineValuation);
  if (wallets.length === 0) return out;

  // Seed every wallet as NO_OBSERVATION. Anything that fails to resolve below
  // therefore stays honestly unknown; nothing can fall through to a zero.
  for (const w of wallets) {
    const asset = nativeAssetForChain(w.walletChain);
    out.set(w.id, {
      accountId: w.id,
      chain:     (w.walletChain ?? "").trim().toUpperCase(),
      assetKey:  asset?.assetKey ?? null,
      symbol:    asset?.symbol ?? null,
      quantity:  null,
      value:     null,
      state:     "NO_OBSERVATION",
      asOf,
      priceDate: null,
    });
  }

  const accountIds = wallets.map((w) => w.id);
  const asOfDate   = new Date(`${asOf}T00:00:00.000Z`);

  // Latest observation per (account, instrument) ≤ asOf — the same cheap
  // indexed shape getCurrentPositions uses, over the same guarded rows.
  const latest = await client.positionObservation.groupBy({
    by:    ["financialAccountId", "instrumentId"],
    where: {
      financialAccountId: { in: accountIds },
      supersededById:     null,
      deletedAt:          null,
      date:               { lte: asOfDate },
    },
    _max: { date: true },
  });

  const pairFilters = latest
    .filter((g): g is typeof g & { _max: { date: Date } } => g._max.date != null)
    .map((g) => ({ financialAccountId: g.financialAccountId, instrumentId: g.instrumentId, date: g._max.date }));

  if (pairFilters.length === 0) return out;

  const [posRows, reconRows] = await Promise.all([
    client.positionObservation.findMany({
      where:  { OR: pairFilters, supersededById: null, deletedAt: null },
      select: POSITION_VALUATION_SELECT,
    }),
    client.positionReconstruction.findMany({
      where:  { financialAccountId: { in: accountIds } },
      select: RECONSTRUCTION_VALUATION_SELECT,
    }),
  ]);

  if (posRows.length === 0) return out;

  // THE canonical valuation path. No price, FX or staleness decision is made here.
  const view = await valuePositionRows({
    client,
    asOf,
    contextSpaceId:    options?.contextSpaceId ?? null,
    reportingCurrency: options?.reportingCurrency ?? "USD",
    holdConstant:      false,
    posRows,
    reconRows,
  });

  // A wallet holds ONE native asset, so one component per account. Should a
  // chain ever carry more, the quantities are not summable across instruments —
  // only the reporting values are, and the quantity is then left unknown rather
  // than being invented.
  const componentsByAccount = new Map<string, typeof view.components>();
  for (const c of view.components) {
    const list = componentsByAccount.get(c.accountId) ?? [];
    list.push(c);
    componentsByAccount.set(c.accountId, list);
  }

  for (const [accountId, components] of componentsByAccount) {
    const seed = out.get(accountId);
    if (!seed) continue;

    const valued = components.filter((c) => c.reportingValue !== null);
    const quantity = components.length === 1 ? components[0].quantity : null;
    const priceDate = components.length === 1 ? components[0].priceDate ?? null : null;

    if (valued.length !== components.length) {
      // At least one held asset could not be priced. We know the quantity; the
      // value is unknown, and a partial subtotal would be a smaller lie than
      // zero but a lie all the same.
      out.set(accountId, { ...seed, quantity, value: null, state: "NO_PRICE", priceDate });
      continue;
    }

    out.set(accountId, {
      accountId,
      chain:     seed.chain,
      assetKey:  seed.assetKey,
      symbol:    seed.symbol,
      quantity,
      value:     valued.reduce((s, c) => s + (c.reportingValue ?? 0), 0),
      state:     "VALUED",
      asOf,
      priceDate,
    });
  }

  return out;
}
