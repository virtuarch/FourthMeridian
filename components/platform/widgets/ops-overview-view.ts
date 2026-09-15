/**
 * components/platform/widgets/ops-overview-view.ts  (PLATFORM OPS OBSERVABILITY)
 *
 * Pure presentation vocabulary for the operations overview: the word and the
 * colour token for a domain state, and the wording for the policy strip. No
 * React, no fetch, no clock — testable by handing it values.
 *
 * Colour never travels alone (platform-surface doctrine): a state maps to a
 * WORD and a token together, and UNKNOWN is muted, never a health colour.
 */

import { TONE_COLOR } from "../platform-surface";
import type { DomainState } from "@/lib/platform/ops/overview-core";

export const STATE_WORD: Record<DomainState, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  FAILED: "Failed",
  STALE: "Stale",
  UNKNOWN: "Unknown",
};

export const STATE_TOKEN: Record<DomainState, string> = {
  HEALTHY: TONE_COLOR.ok,
  DEGRADED: TONE_COLOR.warn,
  FAILED: TONE_COLOR.bad,
  STALE: TONE_COLOR.warn,
  UNKNOWN: TONE_COLOR.muted,
};

export const FACT_TONE_TOKEN = {
  ok: TONE_COLOR.ok,
  warn: TONE_COLOR.warn,
  bad: TONE_COLOR.bad,
  muted: TONE_COLOR.muted,
} as const;

/** The overall line: the worst known state, worded for the header. */
export function overallWord(worst: DomainState): string {
  switch (worst) {
    case "HEALTHY": return "Fourth Meridian is operating normally";
    case "STALE":   return "Something is overdue";
    case "DEGRADED": return "Something is degraded";
    case "FAILED":  return "Something has failed";
    default:        return "Health cannot be established";
  }
}

export function policyStrip(p: { bank: string; wallet: string; bankOrigin: string; walletOrigin: string }): string {
  const origin = (o: string) => (o === "SETTING" ? "set" : o === "DEFAULT" ? "default" : "invalid → default");
  return `Banks every ${p.bank} (${origin(p.bankOrigin)}) · Wallets every ${p.wallet} (${origin(p.walletOrigin)})`;
}

export const OVERVIEW_FOOTNOTE =
  "Every verdict names the authority it was read from. Unknown means the authority recorded no evidence in its window — never that nothing happened.";
