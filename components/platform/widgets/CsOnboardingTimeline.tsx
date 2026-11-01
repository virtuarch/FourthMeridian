"use client";

/**
 * components/platform/widgets/CsOnboardingTimeline.tsx  (PB-7)
 *
 * The audited Customer Success profile's "Onboarding" section: registration
 * (invited or not) → email verified → first session → per connection: linked →
 * history import (complete with N transactions · recovered after interruption ·
 * in progress · failed + reason) → first wealth-history build → first AI turn →
 * first Brief. Renders `detail.onboarding` (lib/platform/customer/onboarding-core.ts)
 * as given — counts, kinds and timestamps only. Mounted by CsCustomersWidget
 * inside the profile panel, so it is only ever shown behind the profile route's
 * CUSTOMER_PROFILE_VIEWED audit.
 */

import type { OnboardingTimeline } from "@/lib/platform/customer/onboarding-core";
import { TONE_COLOR } from "../platform-surface";
import { fmtUtc } from "../widget-kit";
import { IMPORT_STATUS_LABEL, IMPORT_STATUS_TONE, connectionImportDetail } from "./onboarding-view";

const EVENT_TONE = { ok: TONE_COLOR.ok, warn: TONE_COLOR.warn, bad: TONE_COLOR.bad, neutral: TONE_COLOR.muted } as const;

export function CsOnboardingTimeline({ onboarding }: { onboarding: OnboardingTimeline | undefined }) {
  if (!onboarding) return null; // a server from before PB-7
  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--border-hairline)] pt-3" data-cs-onboarding>
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Onboarding</p>

      {onboarding.connections.filter((c) => c.importStatus !== null).length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Connection imports">
          {onboarding.connections.filter((c) => c.importStatus !== null).map((c) => {
            const tone = TONE_COLOR[IMPORT_STATUS_TONE[c.importStatus!]];
            return (
              <li key={c.id} className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 break-words text-[var(--text-secondary)]">{c.label}</span>
                <span className="min-w-0 max-w-full break-words text-right" style={{ color: tone }}>
                  <span className="font-medium">{IMPORT_STATUS_LABEL[c.importStatus!]}</span>
                  {connectionImportDetail(c) && <span className="text-[var(--text-primary)]">{` · ${connectionImportDetail(c)}`}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <ol className="mt-1 flex flex-col" aria-label="Onboarding timeline">
        {onboarding.events.map((e, i) => (
          <li key={`${e.kind}-${e.connectionId ?? ""}-${i}`} className="flex min-w-0 items-start gap-2 py-0.5">
            <span aria-hidden className="mt-1 shrink-0 rounded-full" style={{ width: 6, height: 6, background: EVENT_TONE[e.tone] }} />
            <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">{e.label}</span>
            <span className="shrink-0 tabular-nums text-[10px] text-[var(--text-muted)]">{fmtUtc(e.at)}</span>
          </li>
        ))}
      </ol>

      {onboarding.pending.length > 0 && (
        <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[var(--text-muted)]" aria-label="Not reached yet">
          {onboarding.pending.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {onboarding.floor && <p className="text-[10px] text-[var(--text-faint)]">A read hit its row cap — import verdicts are a floor.</p>}
    </div>
  );
}
