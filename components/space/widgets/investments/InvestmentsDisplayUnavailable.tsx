"use client";

/**
 * components/space/widgets/investments/InvestmentsDisplayUnavailable.tsx  (PB-11b)
 *
 * What the Investments workspace renders when its contract cannot be converted
 * into the display currency (no rate — lib/investments/display-conversion.ts
 * fails CLOSED). Every surface that would carry a figure — the hero, the change,
 * allocation, holdings, concentration, accounts, activity — is replaced by this
 * one statement: the portfolio is unavailable in <ccy>, and why. No figure in
 * any currency is shown, so a source-currency magnitude can never sit under the
 * display-currency label.
 */

import { Surface, Figure } from "@/components/atlas/Surface";
import { HeroEyebrow } from "@/components/space/hero/HeroParts";
import type { InvestmentsDisplayUnavailable as Unavailable } from "@/lib/investments/display-conversion";

export function InvestmentsDisplayUnavailable({ unavailable, figureLabel = "Portfolio value" }: {
  unavailable: Unavailable;
  figureLabel?: string;
}) {
  return (
    <div className="space-y-8 min-w-0">
      <section>
        <HeroEyebrow label={figureLabel} />
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <Figure value="—" size="hero" className="sm:text-5xl leading-none" />
          <span className="text-[11px] text-[var(--text-muted)]">Unavailable in {unavailable.currency}</span>
        </div>
      </section>
      <Surface className="px-4 py-8 text-center">
        <p className="text-sm font-medium text-[var(--text-secondary)]">Investments are unavailable in {unavailable.currency}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{unavailable.reason}</p>
      </Surface>
    </div>
  );
}
