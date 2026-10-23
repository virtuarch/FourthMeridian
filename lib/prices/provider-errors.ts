/**
 * lib/prices/provider-errors.ts
 *
 * V26-PRICE-4 — the explicit provider failure taxonomy.
 *
 * Every acquisition failure used to collapse into one note: "FAILED — <message>".
 * That is enough to know something went wrong and nothing else, and the
 * distinctions it erases change what an operator should DO:
 *
 *   THROTTLED       wait and re-run; the evidence exists and is still coming
 *   PROVIDER_LIMIT  the vendor tier cannot serve this span; upgrade or narrow it
 *   PROVIDER_ERROR  transient or a vendor defect; retry, then investigate
 *   INVALID_DATA    the vendor answered with something unusable — a real defect
 *   EMPTY_RESPONSE  nothing returned INSIDE servable depth; suspicious, investigate
 *   NO_DATA         nothing returned outside servable depth; expected, not a fault
 *   UNSUPPORTED     no capable provider, or two claiming it; a routing question
 *
 * Adapters THROW a typed error; the orchestrator classifies. An adapter that
 * swallowed a 429 and returned an empty array — as the CoinGecko module used to —
 * makes throttling indistinguishable from a delisted tail, which is how a
 * rate-limited backfill looks exactly like a complete one.
 */

/** Codes an adapter may raise. The orchestrator adds the rest from context. */
export type ProviderErrorCode =
  | "THROTTLED"
  | "PROVIDER_LIMIT"
  | "PROVIDER_ERROR"
  | "INVALID_DATA";

/**
 * Every outcome of asking one provider for one window. Ordered from success
 * through explicable emptiness to real faults.
 */
export const PROVIDER_OUTCOMES = [
  "OK",
  "NO_DATA",
  "EMPTY_RESPONSE",
  "INVALID_DATA",
  "THROTTLED",
  "PROVIDER_LIMIT",
  "PROVIDER_ERROR",
  "UNSUPPORTED",
] as const;

export type ProviderOutcome = (typeof PROVIDER_OUTCOMES)[number];

/**
 * Outcomes worth retrying on a later run. NO_DATA and EMPTY_RESPONSE are NOT
 * retryable here — the acquisition planner decides that, because whether to ask
 * again is a coverage question (the dates are still missing) rather than an
 * error-handling one. UNSUPPORTED and INVALID_DATA need a human.
 */
export const RETRYABLE_OUTCOMES: ReadonlySet<ProviderOutcome> = new Set<ProviderOutcome>([
  "THROTTLED",
  "PROVIDER_ERROR",
]);

/** A typed adapter failure. Adapters throw this; fetch orchestration classifies it. */
export class ProviderFetchError extends Error {
  readonly code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderFetchError";
    this.code = code;
  }
}

/** Classify a thrown value. Anything untyped is a PROVIDER_ERROR, never silently OK. */
export function classifyThrown(e: unknown): ProviderOutcome {
  if (e instanceof ProviderFetchError) return e.code;
  return "PROVIDER_ERROR";
}
