/**
 * components/platform/widgets/ops-overview-view.ts  (PLATFORM OPS OBSERVABILITY · UX-P1 status board)
 *
 * Pure presentation vocabulary for the operations overview: the word and the
 * tone for a domain state, the wording for the policy strip, and the shape of
 * the posture row. No React, no fetch, no clock — testable by handing it values.
 *
 * Colour never travels alone (platform-surface doctrine): a state maps to a
 * WORD and a tone together, and UNKNOWN is muted, never a health colour.
 *
 * UX-P1: the status board renders through `StatusTile` / `ToneBadge`, which
 * take a `StatusTone` rather than a raw token. `STATE_TONE` is that mapping;
 * `STATE_TOKEN` stays for the one consumer that still paints a `StatusWord`.
 * Every figure, qualifier and posture word arrives from the server
 * (overview-core.ts) — this file derives nothing from a count.
 */

import { TONE_COLOR, type StatusTone } from "../platform-surface";
import type { DomainState, PostureChip, PostureTone } from "@/lib/platform/ops/overview-core";

export const STATE_WORD: Record<DomainState, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  FAILED: "Failed",
  STALE: "Stale",
  UNKNOWN: "Unknown",
};

/** HEALTHY ok · DEGRADED/STALE warn · FAILED bad · UNKNOWN muted (never green). */
export const STATE_TONE: Record<DomainState, StatusTone> = {
  HEALTHY: "ok",
  DEGRADED: "warn",
  FAILED: "bad",
  STALE: "warn",
  UNKNOWN: "muted",
};

export const STATE_TOKEN: Record<DomainState, string> = {
  HEALTHY: TONE_COLOR[STATE_TONE.HEALTHY],
  DEGRADED: TONE_COLOR[STATE_TONE.DEGRADED],
  FAILED: TONE_COLOR[STATE_TONE.FAILED],
  STALE: TONE_COLOR[STATE_TONE.STALE],
  UNKNOWN: TONE_COLOR[STATE_TONE.UNKNOWN],
};

/** The server's posture tone IS a StatusTone subset; stated so the compiler proves it. */
export const POSTURE_TONE: Record<PostureTone, StatusTone> = { ok: "ok", warn: "warn", bad: "bad", muted: "muted" };

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

/** The accessible name of a posture chip's doorway — visible text first (WCAG 2.5.3). */
export function postureDoorwayLabel(workspaceLabel: string, chip: Pick<PostureChip, "label">): string {
  return `${workspaceLabel} — open the workspace behind ${chip.label}`;
}

/** The one sentence under the board. */
export const OVERVIEW_FOOTNOTE =
  "Every verdict names its authority in Technical details; Unknown means no evidence in the window, never that nothing happened.";
