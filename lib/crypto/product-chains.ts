/**
 * lib/crypto/product-chains.ts
 *
 * WHICH WALLET CHAINS MAY A USER ADD? — the product surface, and only that.
 *
 * Pure: no Prisma, no DB, no server-only import, no adapter import. That is
 * load-bearing rather than tidy — the add-wallet picker is a CLIENT component
 * and the create route is a SERVER one, and before this module they each kept
 * their own list. They had already drifted: the picker offered BNB, the route's
 * `SUPPORTED_CHAINS` did not, so choosing BNB produced a 400 from a menu that
 * had just offered it.
 *
 * ── THIS IS ONE OF THREE INDEPENDENT QUESTIONS. DO NOT MERGE THEM ───────────
 *
 *   1. PRODUCT_SUPPORTED   (here)
 *      May a user create/connect a wallet on this chain? A product decision
 *      about what to put in front of someone. Says NOTHING about what the
 *      system can then do with it.
 *
 *   2. CURRENT_POSITION_SUPPORTED   (lib/crypto/wallet-sync-dispatch.ts)
 *      Has reliable current-balance acquisition been EARNED for this chain?
 *
 *   3. HISTORY_SUPPORTED   (same registry)
 *      Has historical acquisition, reconciliation, replay and dated valuation
 *      been earned — proven on a real wallet, not a fixture?
 *
 * A chain is routinely PRODUCT_SUPPORTED while (2) and (3) are still withheld:
 * recording that you hold a wallet is useful on its own, and the honest answer
 * to "what is it worth" is then a stated refusal rather than a zero. The
 * reverse is also legal — a chain may be capable and deliberately not offered.
 *
 * Configuring a provider earns NOTHING. Enabling a network in a vendor
 * dashboard makes a request possible; it does not make an acquisition path
 * correct, reconciled or proven. Capability is earned by evidence, per chain
 * and per evidence class, and it is earned in the registry — never here.
 *
 * ── HIDING IS NOT DELETING ──────────────────────────────────────────────────
 * Chains removed from this list (Cardano, XRP, and the catch-all "Other") keep
 * every piece of canonical machinery they had. `WalletChain` still names them,
 * the doctrine still governs them, and re-offering one is a single edit here.
 * Narrowing the surface is a statement about what is ready to show, not a claim
 * that the architecture cannot represent them.
 */

/** One offerable chain, with the copy the picker renders. */
export interface ProductChain {
  /** Canonical `FinancialAccount.walletChain` token. */
  value:       string;
  /** Human label, name first then ticker — the form users recognise. */
  label:       string;
  /** Address-format hint for the input. */
  placeholder: string;
}

/**
 * THE product surface. Exactly what the add-wallet picker offers and exactly
 * what the create route accepts.
 *
 * Order is presentation order, and is deliberately capability-first: the chains
 * this system can actually read come before the ones it can only record.
 */
export const PRODUCT_CHAINS: readonly ProductChain[] = [
  { value: "BTC",   label: "Bitcoin (BTC)",   placeholder: "address (bc1…/1…/3…) or xpub/ypub/zpub" },
  { value: "ETH",   label: "Ethereum (ETH)",  placeholder: "0x..." },
  { value: "SOL",   label: "Solana (SOL)",    placeholder: "Base58 address..." },
  { value: "BNB",   label: "BNB Chain (BNB)", placeholder: "0x..." },
  { value: "MATIC", label: "Polygon (MATIC)", placeholder: "0x..." },
  { value: "AVAX",  label: "Avalanche (AVAX)", placeholder: "0x..." },
] as const;

/** The canonical tokens, for validation and diagnostics. */
export const PRODUCT_CHAIN_VALUES: readonly string[] = PRODUCT_CHAINS.map((c) => c.value);

/**
 * May a user add a wallet on this chain?
 *
 * Case-insensitive and trimming, matching the create route's normalisation, so
 * a stale client that posts a lower-case token is judged on the same basis the
 * rest of the pipeline uses rather than being refused for its casing.
 *
 * A chain removed from the picker is refused HERE too. The API is the boundary
 * that matters: hiding an option in a menu is not a restriction if the endpoint
 * behind it still accepts the value.
 */
export function isProductSupportedChain(chain: string | null | undefined): boolean {
  if (!chain) return false;
  return PRODUCT_CHAIN_VALUES.includes(chain.trim().toUpperCase());
}
