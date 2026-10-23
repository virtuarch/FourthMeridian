/**
 * components/platform/widgets/execution-format.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * Pure operator wording for an execution's SOURCE and VERDICT. Kept apart from
 * refresh-format.ts, which is provider-neutral by contract (it must not name a
 * provider); this module has to name source kinds to label them.
 */

import { humanizeToken } from "./refresh-format";


/** The minimal execution row shape these helpers read. */
export interface ExecutionSourceLike {
  sourceKind: string;
  sourceRef: string | null;
  plaidItemId: string | null;
  network: string | null;
}

/**
 * An operator label for an execution's source: the kind, the network for a
 * wallet, and an OPAQUE reference (last 6 of the source's own id). Never an
 * address, never a customer name — a reference the operator can correlate,
 * not identify.
 */
export function describeSource(row: ExecutionSourceLike): { kind: string; label: string; ref: string } {
  const id = row.sourceRef ?? row.plaidItemId ?? "";
  const ref = id ? `…${id.slice(-6)}` : "unknown";
  if (row.sourceKind === "WALLET") {
    const net = row.network ?? "wallet";
    return { kind: "Wallet", label: `${net} wallet ${ref}`, ref };
  }
  if (row.sourceKind === "PLAID_ITEM") return { kind: "Bank", label: `Bank item ${ref}`, ref };
  return { kind: humanizeToken(row.sourceKind), label: `${humanizeToken(row.sourceKind)} ${ref}`, ref };
}

/** Operator wording for a trigger token. */
export function describeTrigger(trigger: string): string {
  switch (trigger) {
    case "MANUAL": return "Manual";
    case "CRON": return "Scheduled";
    case "OPERATOR": return "Operator";
    case "WEBHOOK": return "Webhook";
    case "RECONNECT": return "Reconnect";
    case "ADMIN": return "Admin";
    default: return humanizeToken(trigger);
  }
}

/** Operator wording for a failure category token. */
export function describeCategory(category: string | null): string | null {
  switch (category) {
    case null: return null;
    case "PROVIDER_TIMEOUT": return "provider timed out";
    case "PROVIDER_RATE_LIMITED": return "provider rate-limited";
    case "PROVIDER_AUTH": return "provider needs re-authentication";
    case "PROVIDER_ERROR": return "provider error";
    case "CONFIGURATION": return "deployment not configured";
    case "INPUT": return "stored source is malformed";
    case "UNSUPPORTED": return "no adapter for this source";
    case "INTERNAL": return "internal error after the provider answered";
    case "UNKNOWN": return "failure not classified";
    default: return humanizeToken(category);
  }
}

/** Operator wording for the canonical-state outcome; null is "unknown", never "unchanged". */
export function describeOutcome(outcome: string | null, status: string): string {
  if (outcome === "UPDATED") return "canonical state updated";
  if (outcome === "NO_CHANGE") return "canonical state unchanged (verified)";
  if (status === "FAILED") return "canonical state unknown — the run did not complete";
  return "canonical state unknown — not proven by this run";
}
