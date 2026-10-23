/**
 * lib/crypto/evm-networks.ts
 *
 * W-M3 — the EVM networks this system can ACQUIRE from, as configuration.
 *
 * Pure data plus one lookup. Being listed here says a native-balance request is
 * possible and correctly shaped; it earns NOTHING. Capability is granted one
 * chain at a time in lib/crypto/wallet-sync-dispatch.ts, on evidence, and a
 * network can sit here for a slice or a year before it is registered there.
 *
 * Polygon is the live example: its identity is settled and its config is
 * correct, and it is deliberately NOT in the sync registry because its native
 * asset has no unambiguous price mapping (see coingecko.ts). Configuration
 * readiness and capability are different facts, and this file only supplies one.
 */

import {
  ETH_NATIVE, BNB_NATIVE, POL_NATIVE, AVAX_NATIVE,
} from "@/lib/crypto/native-asset";
import { ALCHEMY_NETWORKS } from "@/lib/crypto/alchemy";
import type { EvmNetworkConfig } from "@/lib/crypto/evm-native";

export const ETH_NETWORK: EvmNetworkConfig = {
  chain: ETH_NATIVE.chain, asset: ETH_NATIVE,
  network: ALCHEMY_NETWORKS.ETHEREUM, urlEnvVar: "ETH_RPC_URL", blockTag: "latest",
};
export const BNB_NETWORK: EvmNetworkConfig = {
  chain: BNB_NATIVE.chain, asset: BNB_NATIVE,
  network: ALCHEMY_NETWORKS.BNB, urlEnvVar: "BNB_RPC_URL", blockTag: "latest",
};
/** Configured and correct; NOT registered for sync — see the header. */
export const POLYGON_NETWORK: EvmNetworkConfig = {
  chain: POL_NATIVE.chain, asset: POL_NATIVE,
  network: ALCHEMY_NETWORKS.POLYGON, urlEnvVar: "POLYGON_RPC_URL", blockTag: "latest",
};
export const AVAX_NETWORK: EvmNetworkConfig = {
  chain: AVAX_NATIVE.chain, asset: AVAX_NATIVE,
  network: ALCHEMY_NETWORKS.AVALANCHE, urlEnvVar: "AVAX_RPC_URL", blockTag: "latest",
};

/** Every configured EVM network, by `walletChain` token. */
export const EVM_NETWORKS: Readonly<Record<string, EvmNetworkConfig>> = {
  [ETH_NETWORK.chain]:     ETH_NETWORK,
  [BNB_NETWORK.chain]:     BNB_NETWORK,
  [POLYGON_NETWORK.chain]: POLYGON_NETWORK,
  [AVAX_NETWORK.chain]:    AVAX_NETWORK,
};

/** The config for a chain token, or null when this is not a configured EVM network. */
export function evmNetworkFor(chain: string | null | undefined): EvmNetworkConfig | null {
  if (!chain) return null;
  return EVM_NETWORKS[chain.trim().toUpperCase()] ?? null;
}
