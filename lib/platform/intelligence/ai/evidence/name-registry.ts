/**
 * lib/platform/intelligence/ai/evidence/name-registry.ts  (Platform AI P5 — the code-reviewed name registry, I-3 / D-3)
 *
 * Design v2 §5.3; S2 binding ruling 6 (2026-11-09). The ONLY names a Platform AI record may
 * carry to the model are the STATIC LITERALS below — a RegistryName field (evidence/
 * record-envelope.ts) is checked against these lists. A name is NEVER read from the database:
 * PlaidItem.institutionName, FinancialAccount.name / institution, Merchant.displayName,
 * MerchantAlias.sample and every other stored string can be customer- or provider-authored text
 * (an injection vector), so a record names an institution / network / merchant ONLY through its
 * stable KEY looked up here; an unlisted key is the generic word (UNLISTED_*) plus a handle.
 *
 *   INSTITUTIONS     keyed by the Plaid `institution_id` (PlaidItem.institutionId) — never by a
 *                    display name. Each entry cites the repo source that pins the id ⇄ name pair;
 *                    an id is added only when it is verified (a guessed id would mislabel a bank).
 *   WALLET_NETWORKS  keyed by the closed native chain codes (lib/crypto/native-asset.ts).
 *   MERCHANTS        keyed by Merchant.canonicalKey — a CURATED subset of the global Merchant
 *                    table (rows with a plaidEntityId only). Empty until a curated list is
 *                    S2-reviewed: every merchant is the generic word until then.
 *
 * EVERY ENTRY IS AN S2 REVIEW ITEM (ruling 6). evidence/name-registry.test.ts asserts each name
 * is a static string literal in this file (no template, call, spread or import), ≤ 40 chars, no
 * digit run ≥ 4, no `@`, URL, brace or control character, and that this module imports nothing.
 *
 * PURE: constants and lookups. No imports, no I/O.
 */

/** The generic words an unlisted key renders as (never the stored name). */
export const UNLISTED_INSTITUTION = "institution";
export const UNLISTED_WALLET_NETWORK = "wallet network";
export const UNLISTED_MERCHANT = "merchant";

/**
 * Plaid institution_id → display name. Sources:
 *   ins_56      lib/transactions/provider-link-extract.ts (CORRELATION_EXTRACTORS, keyed on observed rows)
 *   ins_129562  lib/admin/provider-lifecycle.ts (ROBINHOOD_PLAID_INSTITUTION_ID)
 */
export const INSTITUTIONS: Readonly<Record<string, string>> = Object.freeze({
  ins_56: "Chase",
  ins_129562: "Robinhood",
});

/** Native chain code → network name (lib/crypto/native-asset.ts NATIVE_ASSETS chain codes). */
export const WALLET_NETWORKS: Readonly<Record<string, string>> = Object.freeze({
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  BNB: "BNB Chain",
  MATIC: "Polygon",
  AVAX: "Avalanche",
});

/** Merchant.canonicalKey → display name (curated; S2-reviewed additions only). */
export const MERCHANTS: Readonly<Record<string, string>> = Object.freeze({});

const own = (m: Readonly<Record<string, string>>, k: unknown): string | null =>
  typeof k === "string" && Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null;

/** The registry name for a Plaid institution id, or the generic word. Never the stored institutionName. */
export const institutionName = (plaidInstitutionId: string | null | undefined): string => own(INSTITUTIONS, plaidInstitutionId) ?? UNLISTED_INSTITUTION;
export const walletNetworkName = (chain: string | null | undefined): string => own(WALLET_NETWORKS, chain) ?? UNLISTED_WALLET_NETWORK;
export const merchantName = (canonicalKey: string | null | undefined): string => own(MERCHANTS, canonicalKey) ?? UNLISTED_MERCHANT;

/** Every name a RegistryName field may hold for each registry (the record schema's `names` list). */
export const INSTITUTION_NAMES: readonly string[] = Object.freeze([...new Set([...Object.values(INSTITUTIONS), UNLISTED_INSTITUTION])]);
export const WALLET_NETWORK_NAMES: readonly string[] = Object.freeze([...new Set([...Object.values(WALLET_NETWORKS), UNLISTED_WALLET_NETWORK])]);
export const MERCHANT_NAMES: readonly string[] = Object.freeze([...new Set([...Object.values(MERCHANTS), UNLISTED_MERCHANT])]);

/** Why a name may not be in the registry (the static test applies this to every entry). */
export function registryNameProblems(name: unknown): string[] {
  if (typeof name !== "string") return ["not_a_string"];
  const out: string[] = [];
  if (name.length === 0 || name.length > 40) out.push("length");
  if (/\d{4,}/.test(name)) out.push("digit_run");
  if (name.includes("@")) out.push("at_sign");
  if (/https?:|www\.|:\/\/|\.[a-z]{2,}\//i.test(name)) out.push("url");
  if (/[{}]/.test(name)) out.push("brace");
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) out.push("control");
  if (name !== name.trim()) out.push("whitespace");
  return out;
}
