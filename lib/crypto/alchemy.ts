/**
 * lib/crypto/alchemy.ts
 *
 * THE ALCHEMY PROVIDER EDGE — one key, many chains, no interpretation.
 *
 * Pure except for reading configuration: no Prisma, no DB, no fetch. It answers
 * exactly one question — "what URL, if any, serves this network?" — and nothing
 * above it learns which vendor answered.
 *
 * ── ALCHEMY IS THE PREFERRED PROVIDER, NOT THE TRUTH MODEL ───────────────────
 * Consolidating on one vendor is an OPERATIONAL preference: one credential, one
 * dashboard, one bill, one place to rotate. It buys nothing epistemically.
 * Capability is still earned per chain and per evidence class, and a chain is
 * promoted only on the evidence its own acceptance tests produce.
 *
 * Concretely, this module hands back a URL for STANDARD JSON-RPC and nothing
 * else. Alchemy's interpreted endpoints (`alchemy_getAssetTransfers` and
 * friends) return a vendor's opinion of what a transfer is; that opinion may
 * later serve as an accelerator whose output is re-derived against raw chain
 * evidence, and it may never be the shape a `ChainMovement` is built from.
 * See docs/systems/crypto-networks.md.
 *
 * ── WHY THE KEY LIVES BEHIND A FUNCTION ──────────────────────────────────────
 * So there is exactly one place that knows the URL template. When a chain is
 * added, or a vendor changes a hostname, or a second vendor is introduced for
 * one network, the change is here and the adapters do not move.
 *
 * A missing key is a first-class answer: null means "this deployment cannot
 * reach that network", which is a different fact from "the wallet holds
 * nothing" and must never collapse into it.
 */

/**
 * Alchemy network slugs — the subdomain in `https://<slug>.g.alchemy.com/v2/<key>`.
 *
 * Listing a network here says only that Alchemy SERVES it. It does not claim
 * this deployment's app has it enabled (each network is toggled per app), nor
 * that the tier permits every method on it, nor that Fourth Meridian supports
 * the chain. Those are three further, separately earned facts.
 */
export const ALCHEMY_NETWORKS = {
  SOLANA:   "solana-mainnet",
  ETHEREUM: "eth-mainnet",
  BNB:      "bnb-mainnet",
  // Reachable with the same credential once enabled on the app.
  POLYGON:  "polygon-mainnet",
  BASE:     "base-mainnet",
  ARBITRUM: "arb-mainnet",
  OPTIMISM: "opt-mainnet",
  AVALANCHE: "avax-mainnet",
} as const;

export type AlchemyNetwork = (typeof ALCHEMY_NETWORKS)[keyof typeof ALCHEMY_NETWORKS];

/** The configured Alchemy credential, or null when this deployment has none. */
export function alchemyApiKey(): string | null {
  const key = process.env.ALCHEMY_API_KEY?.trim();
  return key ? key : null;
}

/**
 * The standard JSON-RPC endpoint for a network, or null when unconfigured.
 *
 * The credential is embedded in the path because that is Alchemy's contract.
 * It follows that this URL IS a secret: it must never be logged, echoed into an
 * error message, or stored on a row. Adapters log the network and the failure
 * stage, never the endpoint.
 */
export function alchemyRpcUrl(network: AlchemyNetwork): string | null {
  const key = alchemyApiKey();
  return key ? `https://${network}.g.alchemy.com/v2/${key}` : null;
}

/**
 * Strip a credential out of text before it reaches a log, an error message or a
 * persisted row.
 *
 * Provider errors quote the request URL surprisingly often, and an RPC URL with
 * the key in its path is one careless `console.warn` away from a log aggregator.
 * Every adapter that can surface provider text runs it through this first.
 */
export function redactProviderSecrets(text: string): string {
  const key = alchemyApiKey();
  if (!key) return text;
  return text.split(key).join("«redacted»");
}
