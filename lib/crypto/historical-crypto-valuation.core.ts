/**
 * lib/crypto/historical-crypto-valuation.core.ts
 *
 * V26-S3-DETAIL — THE historical crypto valuation for one day, as POSITIONS.
 *
 * Pure: no Prisma, no DB, no clock, no network.
 *
 * ── Why this was extracted ───────────────────────────────────────────────────
 * Snapshot regeneration valued the day's crypto inline, as a single total, and
 * nothing else could reproduce it. A drill-down therefore had two bad options:
 * recompute crypto its own way (a second engine, guaranteed to disagree
 * eventually) or read the stored column and present it as an unexplained lump.
 *
 * The arithmetic is trivial — native quantity × the day's price — so the value
 * of extracting it is not the sum. It is that the SAME call produces the total
 * the snapshot stores AND the per-position breakdown a user can inspect, so the
 * two can never describe different portfolios.
 *
 * ── What this does NOT decide ────────────────────────────────────────────────
 * Whether the day may be valued at all. Two independent licences gate that and
 * both live with their own authorities:
 *   · a PRICE must have reached the day (the archive's answer);
 *   · the constant-quantity carry must be licensed — which since S1 also
 *     requires the wallet's movement ledger to reconcile.
 * The caller resolves both and passes the verdict in. An unlicensed day yields
 * NO positions and NO total, never a carried balance.
 *
 * ── W-M0 — ONE PRICE PER ASSET, NOT ONE PRICE PER DAY ────────────────────────
 * This took a single `unitPrice: number | null` for the whole account set, and
 * both call sites handed it the Bitcoin close alongside a literal
 * `symbol: "BTC"`. With one chain that is merely redundant. With two it is a
 * silent mispricing: an Ethereum wallet's quantity multiplied by the Bitcoin
 * close, labelled "BTC", summed into digital assets, and stamped `supported`.
 * Nothing in the type system, the tests or the output could have caught it —
 * the arithmetic is valid and the number is plausible.
 *
 * So the price arrives KEYED BY CANONICAL ASSET IDENTITY, each account states
 * the asset its own balance denominates, and an asset with no price refuses the
 * day. The asset a wallet holds is now data (lib/crypto/native-asset.ts), and an
 * account whose chain this system cannot name refuses as UNKNOWN_ASSET rather
 * than falling back to whatever price happens to be in hand.
 *
 * W-M1a — that key is `assetKey` (CAIP-19), never the ticker. A ticker is not
 * unique and for tokens is attacker-controlled, so keying a price map by it
 * would let two assets overwrite each other in the map — mispricing one of them
 * with no error, which is the same class of defect one layer up. `symbol` is
 * still carried and still rendered; it just decides nothing.
 *
 * ── Why refusal stays ALL-OR-NOTHING across assets ───────────────────────────
 * If any held asset lacks a price, the whole day refuses — the same rule that
 * already applied across accounts, extended over the new dimension rather than
 * relaxed on it. Valuing the priced assets and silently dropping the rest would
 * present a partial portfolio as the whole, which is precisely the dishonesty
 * the all-or-nothing rule exists to prevent, and it would do so at a
 * granularity the user cannot see.
 *
 * Per-asset licensing is a real question — a wallet could reasonably be
 * COMPLETE for SOL and PARTIAL for one token — but it is a PRODUCT decision
 * about what a partial crypto total means, not a mechanical consequence of
 * supporting a second chain. It belongs with the net-worth convergence slice
 * that owns what the crypto component asserts. Deliberately deferred, not
 * overlooked.
 */

/** One crypto account's native holding, as the caller already has it. */
export interface CryptoAccountBalance {
  financialAccountId: string;
  name:               string;
  /**
   * Whole units of `symbol` on this day.
   *
   * W6 — `0` and `null` are DIFFERENT FACTS and this field is the boundary where
   * they used to be confused. `0` is a known quantity: the wallet held nothing,
   * which is evidence. `null` is UNKNOWN — no licensed quantity reaches this
   * day — and it is not a quantity at all.
   *
   * Before W6 this was read as `nativeBalance ?? 0` and an unknown quantity was
   * filtered out as immaterial, so a day on which one wallet's history was
   * unknown still reported `licensed: true` and a total composed of the OTHER
   * wallets. The aggregate asserted completeness it did not have. An unknown
   * quantity now refuses the day (QUANTITY_UNKNOWN) unless the account is
   * outside its existence interval — see `applicable`.
   */
  nativeBalance:      number | null;
  /**
   * The CANONICAL IDENTITY of the asset this account's balance denominates,
   * resolved by the binding from the account's chain (`nativeAssetForChain`). It
   * selects the price: hand over the wrong one and the wallet is valued as the
   * wrong asset.
   *
   * NULL when the binding could not name the asset — an absent, blank or
   * unsupported `walletChain`. The day then refuses (UNKNOWN_ASSET). This is the
   * case the pre-W-M0 literal made unrepresentable, by answering "BTC" to a
   * question it had never actually asked.
   */
  assetKey:           string | null;
  /** Display ticker for the rendered position. Decides nothing. */
  symbol:             string | null;
  /**
   * W6 — was this account WITHIN its defensible existence interval on this day?
   *
   * `false` means NOT_APPLICABLE: no evidence places the account here at all, so
   * it contributes nothing AND refuses nothing. That is the difference between
   * "we cannot say what this wallet held in 2023" and "this wallet did not exist
   * in 2023, and its absence is not a gap in the answer".
   *
   * Without this distinction the fix would be unusable: a wallet on a
   * CURRENT_POSITION-only chain has exactly one observation — today's — so every
   * historical day would be an unknown quantity, and adding an Ethereum wallet
   * would black out a year of Bitcoin history. The account is simply not
   * applicable before its evidence begins.
   *
   * Defaults to TRUE when omitted, so a caller that has not thought about
   * existence gets the conservative answer (refuse) rather than a silent drop.
   */
  applicable?:        boolean;
}

/** One crypto position on one date, explained. */
export interface CryptoPositionValuation {
  financialAccountId: string;
  accountName:        string;
  /** Canonical identity of the asset actually valued — never a default. */
  assetKey:           string;
  /** Display ticker. Empty string when the descriptor carried none. */
  symbol:             string;
  quantity:           number;
  /** Native-currency (USD) unit price used. */
  unitPrice:          number;
  /** quantity × unitPrice, in the price's currency (USD). */
  nativeValue:        number;
}

export interface CryptoDayValuation {
  /** Empty when the day is not licensed — never a zero-valued position. */
  positions: CryptoPositionValuation[];
  /** Σ nativeValue. Meaningful only when `licensed`. */
  nativeTotal: number;
  /** How many crypto positions EXISTED on this day (the denominator's share). */
  positionCount: number;
  licensed: boolean;
  /**
   * Coded reason when not licensed.
   *
   * QUANTITY_UNKNOWN (W6) — an account within its existence interval had NO
   * licensed quantity on this day. Distinct from QUANTITY_UNLICENSED, which is
   * the caller's verdict about the constant-quantity CARRY for the whole day;
   * this one is per account and says the evidence never reached the date.
   */
  refusal: "UNKNOWN_ASSET" | "NO_PRICE" | "QUANTITY_UNLICENSED" | "QUANTITY_UNKNOWN" | null;
  /**
   * W6 — WHICH accounts had an unknown quantity, sorted. Named by account rather
   * than by asset because two wallets on the same chain fail independently: one
   * may be fully reconstructed while the other has no history at all.
   */
  unknownQuantityAccountIds: readonly string[];
  /**
   * W-M0 — WHICH assets forced the refusal, as canonical assetKeys, sorted, so a
   * caller can say what is missing instead of only that something is. Empty when
   * licensed, and empty for UNKNOWN_ASSET (the whole point of which is that the
   * asset has no identity to name).
   */
  unpricedAssetKeys: readonly string[];
}

export interface CryptoDayInput {
  accounts: readonly CryptoAccountBalance[];
  /**
   * The day's USD price per whole unit, KEYED BY CANONICAL assetKey.
   *
   * This map is TWO statements, and both are load-bearing:
   *   1. what each asset was worth on this day — null, or absent, meaning no
   *      price reached it (a refusal, never a zero, never another asset's price);
   *   2. WHICH ASSETS ARE IN PLAY. Its keys are the caller's declaration of the
   *      asset set this day concerns, which is why an entry may legitimately
   *      exist for an asset no account currently holds.
   *
   * (2) preserves the pre-W-M0 contract exactly. The old scalar `unitPrice` was
   *     a fact about THE DAY, checked before anything was known about holdings:
   *     "no BTC close reached this date" refused the day whether or not a wallet
   *     held anything. Requiring a price only for HELD assets would quietly drop
   *     that check whenever every wallet was empty, and a Space whose only wallet
   *     had been drained would flip from "no evidence, preserve what is stored"
   *     to "evidence: digital assets are zero" — absence converted into zero,
   *     which is the one thing this engine must never do.
   *
   * Build it from the accounts in play (both production call sites do). Handing
   * in a SUPERSET — every crypto price the deployment knows — would refuse days
   * over assets nobody holds.
   */
  unitPriceByAssetKey: Readonly<Record<string, number | null>>;
  /** Did the constant-quantity carry licence (incl. ledger completeness) pass? */
  quantityLicensed: boolean;
  /** Below this, a balance is not a position. Mirrors the crypto materiality floor. */
  materialityEpsilon?: number;
}

const DEFAULT_MATERIALITY = 0;

/**
 * Value every crypto account on one day. Total and deterministic; never throws.
 *
 * Positions are emitted in account-id order so the breakdown and the total are
 * built in one pass, in one order, and cannot describe different sets.
 *
 * A wallet with no material balance is not a position and is absent from BOTH
 * the count and the total — it is not a zero-valued holding, it is not a
 * holding.
 */
export function valueCryptoDay(input: CryptoDayInput): CryptoDayValuation {
  const eps = input.materialityEpsilon ?? DEFAULT_MATERIALITY;

  // W6 — an account outside its defensible existence interval is NOT_APPLICABLE:
  // it is not part of this day's question, so it neither contributes nor refuses.
  // Everything below reasons only about accounts that were actually here.
  const inScope = input.accounts.filter((a) => a.applicable !== false);

  // The three states `nativeBalance` can be in, kept apart on purpose.
  //   null   → UNKNOWN. No licensed quantity reached this day.
  //   0      → CONFIRMED ZERO. Known, evidenced, and not a position.
  //   other  → a held quantity.
  const unknownQuantityAccountIds = inScope
    .filter((a) => a.nativeBalance === null)
    .map((a) => a.financialAccountId)
    .sort();
  const held = inScope
    .filter((a) => a.nativeBalance !== null && Math.abs(a.nativeBalance) > eps)
    .sort((a, b) => a.financialAccountId.localeCompare(b.financialAccountId));

  // A position that EXISTED includes one whose quantity we could not establish —
  // it is a hole in the answer, and a denominator that omitted it would report
  // "N of N valued" on a day that was materially incomplete.
  const existedCount = held.length + unknownQuantityAccountIds.length;

  const refuse = (
    refusal: NonNullable<CryptoDayValuation["refusal"]>,
    unpricedAssetKeys: readonly string[] = [],
  ): CryptoDayValuation => ({
    positions: [], nativeTotal: 0, positionCount: existedCount,
    licensed: false, refusal, unpricedAssetKeys, unknownQuantityAccountIds,
  });

  // 1. AN UNNAMED ASSET IS NOT A PRICING FAILURE. It is a failure to know what
  //    is held, and reporting it as NO_PRICE would send the reader looking for a
  //    price we could not have asked for. Checked FIRST for that reason.
  if (held.some((a) => !a.assetKey)) return refuse("UNKNOWN_ASSET");

  // 1b. W6 — AN UNKNOWN QUANTITY IS NOT AN ABSENT ONE, AND THE DAY MUST SAY SO.
  //     This is the defect the slice exists to close. The account was here; what
  //     it held is unrecoverable from the evidence we have. Reporting the other
  //     wallets' total as the day's crypto would be a complete-looking number
  //     with a material constituent silently missing — the precise shape of
  //     dishonesty the all-or-nothing rule prevents everywhere else.
  //
  //     Checked before pricing for the same reason UNKNOWN_ASSET is: a price
  //     cannot rescue a quantity nobody knows.
  if (unknownQuantityAccountIds.length > 0) return refuse("QUANTITY_UNKNOWN");

  // 2. Every asset IN PLAY must have a usable price — the held ones and the ones
  //    the caller declared by naming them in the map. See `unitPriceByAssetKey`:
  //    the declared half is what keeps "no price reached this day" a fact about
  //    the day rather than a fact about holdings, exactly as the pre-W-M0 scalar
  //    was. Collected rather than short-circuited so the refusal can name all of
  //    the missing assets at once.
  const priceOf = (assetKey: string): number | null => {
    const p = input.unitPriceByAssetKey[assetKey];
    return p != null && Number.isFinite(p) && p > 0 ? p : null;
  };
  const inPlay = new Set<string>([...Object.keys(input.unitPriceByAssetKey), ...held.map((a) => a.assetKey!)]);
  const unpriced = [...inPlay].filter((k) => priceOf(k) === null).sort();
  if (unpriced.length > 0) return refuse("NO_PRICE", unpriced);

  if (!input.quantityLicensed) return refuse("QUANTITY_UNLICENSED");

  const positions = held.map((a) => {
    // Non-null by construction — `held` filtered out both unknown and zero.
    const quantity  = a.nativeBalance!;
    const unitPrice = priceOf(a.assetKey!)!;
    return {
      financialAccountId: a.financialAccountId,
      accountName:        a.name,
      assetKey:           a.assetKey!,
      symbol:             a.symbol ?? "",
      quantity,
      unitPrice,
      nativeValue:        quantity * unitPrice,
    };
  });

  return {
    positions,
    nativeTotal:       positions.reduce((n, p) => n + p.nativeValue, 0),
    positionCount:     positions.length,
    licensed:          true,
    refusal:           null,
    unpricedAssetKeys: [],
    unknownQuantityAccountIds: [],
  };
}
