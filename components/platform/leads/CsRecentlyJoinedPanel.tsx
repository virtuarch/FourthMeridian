"use client";

/**
 * components/platform/leads/CsRecentlyJoinedPanel.tsx  (PB-7 — "Recently joined (14 d)")
 *
 * One row per customer who registered in the last 14 days: who, when, the
 * furthest onboarding stage and an import-health dot (green complete · amber
 * in progress or recovered · red failed · grey nothing linked). Reads the
 * CUSTOMER_SUCCESS READ route customer-success/recently-joined — never the
 * counts-only overview DTO — and a row opens the AUDITED profile in the hosted
 * Customers list (cs-open-customer.ts). The dashboard mounts it only when that
 * list is hosted for this viewer.
 */

import { Block, Surface } from "@/components/atlas/Surface";
import { useSharedWidgetFetch } from "../workspace-session";
import type { RecentlyJoinedResponse } from "@/app/api/platform/customer-success/recently-joined/route";
import { TONE_COLOR } from "../platform-surface";
import { timeAgo } from "../widget-kit";
import { DOT_TONE, dotWord } from "../widgets/onboarding-view";
// PB-7 Preview nit (b) — the Customers list's display-identity rule (username → name → opaque ref), never the raw email.
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { ChartMessage, goToSection } from "./visual-kit";
import { requestOpenCustomer } from "./cs-open-customer";

export const RECENTLY_JOINED_URL = "/api/platform/customer-success/recently-joined?days=14";

export function CsRecentlyJoinedPanel() {
  const f = useSharedWidgetFetch<RecentlyJoinedResponse>(RECENTLY_JOINED_URL);
  return <CsRecentlyJoinedSurface data={f.data} loading={f.loading} error={f.error} />;
}

export function CsRecentlyJoinedSurface({ data, loading, error }: { data: RecentlyJoinedResponse | null; loading: boolean; error: string | null }) {
  const open = (id: string) => { requestOpenCustomer(id); goToSection("cs-customers"); };
  return (
    <Block id="cs-recently-joined" label="Recently joined" className="min-w-0"
      hint={<span className="text-[11px] text-[var(--text-faint)]">{data ? `Last ${data.windowDays} d · ${data.total} customer${data.total === 1 ? "" : "s"}` : "Last 14 d"}</span>}>
      <Surface className="flex-1 px-4 py-2 sm:px-5">
        {!data ? (
          <ChartMessage>{loading ? "Reading recent sign-ups…" : `Recent sign-ups unavailable${error ? ` — ${error}` : ""}`}</ChartMessage>
        ) : data.rows.length === 0 ? (
          <p className="py-3 text-xs text-[var(--text-secondary)]">No customers registered in the last {data.windowDays} days.</p>
        ) : (
          <ul className="flex flex-col" aria-label="Customers who registered recently" data-recently-joined>
            {data.rows.map((r) => (
              <li key={r.id} className="border-t border-[var(--border-hairline)] first:border-t-0">
                <button type="button" onClick={() => open(r.id)} aria-label={`Open the profile of ${operatorDisplayName(r)}`}
                  className="flex min-h-11 w-full items-center gap-3 text-left text-xs hover:bg-[var(--surface-hover)] lg:min-h-9">
                  <span aria-hidden className="shrink-0 rounded-full" title={dotWord(r.importHealth, r)}
                    style={{ width: 8, height: 8, background: TONE_COLOR[DOT_TONE[r.importHealth]] }} />
                  <span className="sr-only">{dotWord(r.importHealth, r)}</span>
                  <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{operatorDisplayName(r)}</span>
                  <span className="hidden shrink-0 text-[var(--text-secondary)] sm:inline">{r.stage ?? "—"}</span>
                  <span className="shrink-0 tabular-nums text-[var(--text-muted)]">{`${timeAgo(r.joinedAt)} ago${r.invited ? "" : " · uninvited"}`}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {data?.floor && <p className="py-1 text-[10px] text-[var(--text-faint)]">Showing the newest {data.rows.length} — a read reached its cap.</p>}
      </Surface>
    </Block>
  );
}
