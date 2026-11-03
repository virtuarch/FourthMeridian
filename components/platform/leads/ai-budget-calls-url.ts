/**
 * components/platform/leads/ai-budget-calls-url.ts  (AI & Costs — budget KPI deep link)
 *
 * The budget drilldown's state in the Space URL, so the open drawer survives a
 * refresh and is linkable — the PB-9 idiom (merchant-records-url.ts):
 *
 *   ?aicalls=budget          the per-call drawer is open
 *   &aiuntil=<epoch ms>      the KPI's window END (its checkedAt), so a refresh
 *                            reopens the SAME 24 h, not a window that slid
 *   &aipage=2                the page
 *
 * Written through the ONE URL seam (useSpaceUrl) with REPLACE intent — opening
 * or paging refines the current entry, never a Back/Forward step. All three are
 * workspace-scoped (cleared by a user workspace switch). Values are read with
 * the SAME parser the route validates with (parseBudgetCallsQuery), so the URL
 * can never name a state the server refuses — an unknown value is dropped.
 */

import { parseBudgetCallsQuery } from "@/lib/platform/ai/budget-calls-core";

export const AI_BUDGET_CALLS_URL_PARAMS = ["aicalls", "aiuntil", "aipage"] as const;
export const AI_BUDGET_CALLS_URL = "/api/platform/platform-ops/ai-budget/calls";

export interface AiBudgetCallsUrlState {
  open: boolean;
  /** The window end in ms, or null for "now" (no KPI read yet). */
  untilMs: number | null;
  page: number;
}

export const CLOSED_CALLS: AiBudgetCallsUrlState = { open: false, untilMs: null, page: 1 };

/** Read the state from a search string. `nowMs` bounds `aiuntil` exactly as the route does. */
export function readAiBudgetCallsUrl(search: string, nowMs: number): AiBudgetCallsUrlState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (p.get("aicalls") !== "budget") return CLOSED_CALLS;
  const probe = new URLSearchParams();
  const until = p.get("aiuntil");
  if (until) probe.set("until", until);
  const page = p.get("aipage");
  if (page) probe.set("page", page);
  const q = parseBudgetCallsQuery(probe, nowMs);
  // An aiuntil the parser refused (q.untilMs fell back to now) is dropped, never kept.
  const kept = until !== null && q.untilMs !== nowMs ? q.untilMs : null;
  return { open: true, untilMs: kept, page: q.page };
}

/** The URL update for a state: a closed drawer deletes every key (a clean URL). */
export function aiBudgetCallsUrlUpdate(s: AiBudgetCallsUrlState): Record<string, string | null> {
  return {
    aicalls: s.open ? "budget" : null,
    aiuntil: s.open && s.untilMs !== null ? String(s.untilMs) : null,
    aipage: s.open && s.page > 1 ? String(s.page) : null,
  };
}

/** The records API path for a state (the route re-validates everything). */
export function aiBudgetCallsApiPath(s: AiBudgetCallsUrlState): string | null {
  if (!s.open) return null;
  const p = new URLSearchParams();
  if (s.untilMs !== null) p.set("until", String(s.untilMs));
  if (s.page > 1) p.set("page", String(s.page));
  const qs = p.toString();
  return qs ? `${AI_BUDGET_CALLS_URL}?${qs}` : AI_BUDGET_CALLS_URL;
}

/** Opening from the KPI: page one of the KPI's own window (its checkedAt). */
export function openBudgetCalls(checkedAtIso: string | null): AiBudgetCallsUrlState {
  const t = checkedAtIso ? Date.parse(checkedAtIso) : NaN;
  return { open: true, untilMs: Number.isFinite(t) ? t : null, page: 1 };
}
