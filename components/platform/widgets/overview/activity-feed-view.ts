/**
 * components/platform/widgets/overview/activity-feed-view.ts  (UX-P1 · Agent 5)
 *
 * THE PURE WORDING behind "Recent operator activity": result words and their
 * tones (the audit ledger's own vocabulary SUCCESS / FAILURE / REFUSED), the
 * reason-code labels, and a UTC-stable "when" that takes `nowMs` as a parameter
 * so the row reads the same on the server and in a test.
 */

import type { StatusTone } from "../../platform-surface";

export const FEED_EMPTY_TEXT = "No operator actions recorded on platform objects in the window.";

export function resultTone(result: "SUCCESS" | "FAILURE" | "REFUSED" | null): StatusTone {
  switch (result) {
    case "SUCCESS": return "ok";
    case "FAILURE": return "bad";
    case "REFUSED": return "warn";
    default: return "muted";
  }
}

export function resultWord(result: "SUCCESS" | "FAILURE" | "REFUSED" | null): string {
  switch (result) {
    case "SUCCESS": return "succeeded";
    case "FAILURE": return "failed";
    case "REFUSED": return "refused";
    default: return "recorded";
  }
}

const REASON_LABEL: Record<string, string> = {
  BETA_ONBOARDING: "beta onboarding", SUPPORT_REQUEST: "support request", DOGFOOD: "dogfood", TESTING: "testing",
  POLICY_ROLLOUT: "policy rollout", INCIDENT: "incident", ABUSE: "abuse", OTHER: "other",
};

export function reasonLabel(code: string | null): string | null {
  return code ? (REASON_LABEL[code] ?? code.replace(/_/g, " ").toLowerCase()) : null;
}

/** "14 Oct, 11:32 UTC" — UTC, no locale drift. */
export function utcStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const d = new Date(t);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}, ${hh}:${mm} UTC`;
}

/** "3 min ago" / "2 h ago" / "5 d ago" relative to `nowMs`; never negative. */
export function relativeText(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}
