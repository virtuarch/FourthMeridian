/**
 * lib/plaid/refresh-verdict.core.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * The VERDICT an execution earns at its completion write: which stage failed,
 * what kind of failure it was, and what happened to canonical state. Pure —
 * no clock, no database, no provider — so the same rule classifies a Plaid
 * refresh and a wallet refresh, and a test can pin every branch.
 *
 * WHY DERIVED, NOT ASSERTED. A producer could stamp "PROVIDER_TIMEOUT" itself,
 * and each producer would spell it differently. Deriving it here from evidence
 * the producer already records (a typed error code where one exists, the error
 * message otherwise) keeps one taxonomy across every source kind and lets a
 * producer contribute an OVERRIDE only for what it genuinely knows better —
 * the wallet dispatcher knows the adapter's own stage name; the Plaid path
 * knows nothing this rule cannot read off its stage records.
 *
 * WHY COARSE. An operator triaging a failed refresh needs to know whether to
 * wait (timeout / rate limit), reconnect (auth), fix the deployment
 * (configuration), fix the record (input), or read the code (internal). The
 * provider's own error taxonomy stays where it is recorded (ProviderCall,
 * SyncIssue) and is never flattened into this one.
 */

import type {
  ExecutionVerdict,
  RefreshFailureCategory,
  RefreshOutcome,
  RefreshStageRecord,
} from "@/lib/plaid/refresh-execution-types";

/** Evidence a producer can offer for classification. All optional. */
export interface FailureEvidence {
  /** A typed code the producer already records (WalletSyncErrorCode, Plaid error_code, …). */
  code?: string | null;
  /** The error message / reason, as recorded. Never displayed by this module. */
  message?: string | null;
}

/**
 * Typed codes that classify on their own. Both the wallet dispatcher's generic
 * codes (lib/crypto/wallet-sync-dispatch.ts) and Plaid's error codes are listed,
 * so neither producer needs a mapping of its own.
 */
const CODE_CATEGORY: Readonly<Record<string, RefreshFailureCategory>> = {
  // Wallet dispatcher — WalletSyncErrorCode
  PROVIDER_NOT_CONFIGURED:      "CONFIGURATION",
  INVALID_WALLET_ADDRESS:       "INPUT",
  BALANCE_UNAVAILABLE:          "PROVIDER_ERROR",
  POSITION_CAPTURE_UNAVAILABLE: "INTERNAL",
  CHAIN_UNSUPPORTED:            "UNSUPPORTED",
  ADAPTER_ERROR:                "INTERNAL",
  // Plaid — error_code values that name a response an operator can act on.
  RATE_LIMIT_EXCEEDED:          "PROVIDER_RATE_LIMITED",
  ITEM_LOGIN_REQUIRED:          "PROVIDER_AUTH",
  INVALID_ACCESS_TOKEN:         "PROVIDER_AUTH",
  INVALID_CREDENTIALS:          "PROVIDER_AUTH",
  ITEM_NOT_FOUND:               "PROVIDER_AUTH",
  INSTITUTION_DOWN:             "PROVIDER_ERROR",
  INSTITUTION_NOT_RESPONDING:   "PROVIDER_ERROR",
  INTERNAL_SERVER_ERROR:        "PROVIDER_ERROR",
  PLANNED_MAINTENANCE:          "PROVIDER_ERROR",
  PRODUCT_NOT_READY:            "PROVIDER_ERROR",
};

/**
 * COARSE codes: a producer's "could not be read this run" bucket, which
 * deliberately spans transport failures, rate limits and bad responses
 * (WalletSyncErrorCode BALANCE_UNAVAILABLE). For these the message is consulted
 * FIRST — "did not respond within 10000 ms" is a timeout an operator should
 * see as one — and the code's category is only the fallback.
 */
const COARSE_CODES: ReadonlySet<string> = new Set(["BALANCE_UNAVAILABLE"]);

/** Message patterns, consulted only when no typed code decided. Order matters. */
const MESSAGE_RULES: readonly { category: RefreshFailureCategory; pattern: RegExp }[] = [
  { category: "PROVIDER_TIMEOUT",      pattern: /\b(aborted|abort(?:ed)? ?signal|timed? ?out|timeout|ETIMEDOUT|deadline|did not respond)\b/i },
  { category: "PROVIDER_RATE_LIMITED", pattern: /\b(rate[ -]?limit(?:ed)?|too many requests|429|quota)\b/i },
  { category: "PROVIDER_AUTH",         pattern: /\b(login required|re-?auth|unauthori[sz]ed|401|403|consent|credential)\b/i },
  { category: "CONFIGURATION",         pattern: /\b(not configured|no .* endpoint|missing .*(key|token|url)|is not set)\b/i },
  { category: "INPUT",                 pattern: /\b(invalid (address|xpub|descriptor)|malformed|not well-formed)\b/i },
  { category: "PROVIDER_ERROR",        pattern: /\b(network error|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|5\d\d|bad gateway|service unavailable|upstream|fetch failed|provider)\b/i },
];

/**
 * Classify a failure. A typed code wins; a message is consulted only when the
 * code is absent or unknown to this table; nothing recognisable ⇒ UNKNOWN. Pure.
 *
 * A code that is itself a category name (a producer that already speaks this
 * vocabulary) passes through unchanged — no double mapping.
 */
export function classifyFailureCategory(evidence: FailureEvidence): RefreshFailureCategory {
  const code = evidence.code?.trim();
  const byMessage = (): RefreshFailureCategory | null => {
    const message = evidence.message ?? "";
    if (message.trim().length === 0) return null;
    for (const rule of MESSAGE_RULES) if (rule.pattern.test(message)) return rule.category;
    return null;
  };
  if (code) {
    if (isFailureCategory(code)) return code;
    const byCode = CODE_CATEGORY[code];
    if (byCode && COARSE_CODES.has(code)) return byMessage() ?? byCode;
    if (byCode) return byCode;
  }
  return byMessage() ?? "UNKNOWN";
}

const CATEGORIES: readonly RefreshFailureCategory[] = [
  "PROVIDER_TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_AUTH", "PROVIDER_ERROR",
  "CONFIGURATION", "INPUT", "UNSUPPORTED", "INTERNAL", "UNKNOWN",
];

export function isFailureCategory(value: string): value is RefreshFailureCategory {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** The first stage that FAILED, in ledger order, or undefined. */
export function firstFailedStage(stages: readonly RefreshStageRecord[]): string | undefined {
  return stages.find((s) => s.status === "FAILED")?.endpoint;
}

/**
 * What the stages PROVE about canonical state.
 *
 *   UPDATED    some attempted stage reported records written or changed (> 0),
 *              or reported freshness advanced with a positive change count.
 *   NO_CHANGE  every attempted stage that reported a count reported zero
 *              written AND zero changed — and at least one did report.
 *   undefined  nothing reported a count (absence is not "unchanged"), or the
 *              execution attempted nothing.
 *
 * A FAILED stage never contributes a count: a failure proves nothing about the
 * rows it did not write. Pure.
 */
export function deriveOutcome(stages: readonly RefreshStageRecord[]): RefreshOutcome | undefined {
  let reported = false;
  for (const s of stages) {
    if (s.status !== "SUCCEEDED") continue;
    const written = s.recordsWritten;
    const changed = s.recordsChanged;
    if (written == null && changed == null) continue;
    reported = true;
    if ((written ?? 0) > 0 || (changed ?? 0) > 0) return "UPDATED";
  }
  return reported ? "NO_CHANGE" : undefined;
}

/**
 * The verdict for a completed execution: the generic derivation, then the
 * producer's override for the fields it genuinely knows better. Fields the
 * override leaves undefined keep the derived value; a field neither knows
 * stays absent. Pure.
 *
 * `failed` is the caller's own knowledge (a thrown error, or a derived overall
 * status of FAILED/PARTIAL): failure fields are only ever set on a failure, so
 * a SUCCEEDED execution can never carry a category by accident.
 */
export function buildVerdict(input: {
  stages: readonly RefreshStageRecord[];
  failed: boolean;
  error?: FailureEvidence;
  override?: ExecutionVerdict;
}): ExecutionVerdict {
  const verdict: ExecutionVerdict = {};
  if (input.failed) {
    const stage = input.override?.failureStage ?? firstFailedStage(input.stages);
    if (stage) verdict.failureStage = stage;
    const evidence: FailureEvidence = input.error ?? {
      message: input.stages.find((s) => s.status === "FAILED")?.errorSummary ?? null,
    };
    verdict.failureCategory = input.override?.failureCategory ?? classifyFailureCategory(evidence);
  }
  const outcome = input.override?.outcome ?? deriveOutcome(input.stages);
  if (outcome) verdict.outcome = outcome;
  return verdict;
}
