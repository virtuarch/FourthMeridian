"use client";

/**
 * components/platform/comms/PreferencesView.tsx  (Customer Success — Communications Center › Preferences)
 *
 * The aggregate preference matrix (contract §4.12) — category × channel, how
 * many ACTIVE accounts turned each off or on against its default. Counts only;
 * operators cannot change anyone's preferences. Small cells (1–4) arrive as
 * `null` + `withheld` and render as "<5", distinctly from "not observed" (—).
 *
 * The route belongs to Session 1 and is not deployed yet: the view PROBES
 * GET /preferences, shows "coming soon" on 404 / 501, and renders on 200.
 */

import { Lock } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import { preferencesUrl } from "@/lib/platform/comms-center/client";
import type { PreferenceAggregate, PreferenceCell } from "@/lib/platform/comms-center/contract-v1-section-4";
import { COMMS_POLICY, aggregateCell, countCell, humanize, utcStamp } from "./comms-model";
import { CountText, PolicyNote, ReadState, okData, useCommsRead, type CommsRead } from "./comms-kit";

const n = (v: number) => v.toLocaleString("en-US");

export const PREFERENCES_COMING_SOON =
  "The preference overview arrives with the notification read APIs. It will show, per category and channel, how many customers changed the default — never who.";

const CHANNELS = [["IN_APP", "In-app"], ["EMAIL", "Email"]] as const;

function Cell({ cell }: { cell: PreferenceCell }) {
  return (
    <span className="flex flex-col gap-0.5 text-[11px]">
      <span className="text-[var(--text-muted)]">Default {cell.default ? "on" : "off"}</span>
      <span className="tabular-nums text-[var(--text-secondary)]">Turned off <CountText cell={countCell(cell.optedOut, cell.withheld)} /></span>
      <span className="tabular-nums text-[var(--text-secondary)]">Turned on <CountText cell={countCell(cell.optedIn, cell.withheld)} /></span>
    </span>
  );
}

export function PreferencesSurface({ read }: { read: CommsRead<PreferenceAggregate> }) {
  const d = okData(read);
  return (
    <div className="flex min-w-0 flex-col gap-8 md:gap-10" data-comms-view="preferences">
      <Block id="comms-preferences" label="Customer preferences" className="min-w-0"
        hint={<span className="text-[11px] text-[var(--text-faint)]">Aggregate · read-only</span>}>
        <Surface className="flex min-w-0 flex-col gap-4 p-4 sm:p-5">
          <ReadState read={read} what="the preference overview" comingSoon={PREFERENCES_COMING_SOON} />
          {d && (
            <>
              <p className="text-xs text-[var(--text-secondary)]">
                <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">{n(d.population)}</span> active customer accounts
              </p>
              <ul aria-label="Preferences by category" className="flex min-w-0 flex-col divide-y divide-[var(--border-hairline)]" data-preference-matrix>
                {d.rows.map((r) => (
                  <li key={r.category} className="grid min-w-0 grid-cols-1 gap-2 py-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-4" data-preference-row={r.category}>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-[var(--text-primary)]">
                      {humanize(r.category)}
                      {r.locked && <span className="inline-flex items-center gap-1 text-[10px] font-normal" style={{ color: "var(--accent-warning)" }}><Lock size={10} aria-hidden /> Locked</span>}
                    </span>
                    <div className="grid min-w-0 grid-cols-2 gap-3 sm:contents">
                      {CHANNELS.map(([ch, label]) => (
                        <div key={ch} className="min-w-0">
                          <p className="mb-0.5 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
                          <Cell cell={r.channels[ch]} />
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
              <PolicyNote>“&lt;5” = withheld: fewer than 5 customers, not shown to protect privacy. “—” = not observed. Locked categories (security) can’t be turned off — {COMMS_POLICY.protectedAlerts.toLowerCase()}</PolicyNote>

              {d.coupledSuppression.length > 0 && (
                <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">Hidden side effects</p>
                  <ul className="flex flex-col gap-2" aria-label="Coupled suppression">
                    {d.coupledSuppression.map((c) => (
                      <li key={c.key} className="flex min-w-0 flex-col gap-0.5 text-[11px]">
                        <span className="flex flex-wrap items-center gap-2">
                          <code className="break-all font-mono text-[var(--text-primary)]">{c.key}</code>
                          <span className="tabular-nums text-[var(--text-secondary)]">customers affected <CountText cell={aggregateCell(c.usersAffected)} /></span>
                        </span>
                        <span className="text-[var(--text-muted)]">{c.explanation}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <span className="text-[11px] tabular-nums text-[var(--text-muted)]" data-list-meta>
                Checked {utcStamp(d.checkedAt)}{d.floor ? " · Totals are a floor — a scan limit was reached." : " · complete (not a floor)"}
              </span>
            </>
          )}
          <PolicyNote>Operators can’t change a customer’s preferences. {COMMS_POLICY.noPii}</PolicyNote>
        </Surface>
      </Block>
    </div>
  );
}

export function CommsPreferencesLead() {
  const read = useCommsRead<PreferenceAggregate>(preferencesUrl());
  return <PreferencesSurface read={read} />;
}
