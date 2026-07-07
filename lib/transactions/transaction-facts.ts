/**
 * lib/transactions/transaction-facts.ts
 *
 * Transaction Intelligence — durable single-row facts (TI2).
 *
 * TI2-1 (this slice) seeds this module with ONLY the shared fact version.
 * The write helper (`buildTransactionFacts`, TI2-3), metadata capture (TI2-2),
 * and writer wiring (TI2-4/5) land in later slices. No builder, no capture, no
 * write path here yet — schema foundation only.
 */

/**
 * Version of the TI2 durable-fact computation. Persisted on each stamped row
 * (Transaction.tiFactsVersion) so a later, improved fact builder can re-run over
 * only stale rows (`WHERE tiFactsVersion < TI_FACTS_VERSION`) without disturbing
 * higher-version ones — the same selective-backfill pattern as
 * FLOW_CLASSIFIER_VERSION (lib/transactions/flow-classifier.ts). Bump this
 * whenever the fact-derivation rules change. Additive constant — nothing reads
 * it in TI2-1.
 *   1 = TI2 initial ruleset.
 */
export const TI_FACTS_VERSION = 1;
