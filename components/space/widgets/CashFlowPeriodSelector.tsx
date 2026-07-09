"use client";

/**
 * components/space/widgets/CashFlowPeriodSelector.tsx
 *
 * Cash Flow Perspective time controls (UX-PER-3 refinement) — RELATIVE periods
 * only:
 *
 *   [ WTD · MTD · QTD · YTD ]        [ 1W · 1M · 1Q · 1Y ]
 *   └─ to-date (far left) ─┘         └─ solid rolling (far right) ─┘
 *
 * Both groups reuse the Atlas SegmentedControl (sliding highlight). Explicit
 * historical selection (specific month / quarter / year) now lives INSIDE the
 * Cash Flow History widget's own Month/Quarter/Year dropdowns, so this global
 * control stays calm and never grows a giant history list.
 *
 * Selecting anything here updates the single `period` all Cash Flow widgets
 * read. No persistence, no URL state.
 */

import { SegmentedControl } from "@/components/atlas/SegmentedControl";
import {
  TO_DATE_PERIODS,
  ROLLING_PERIODS,
  isExplicitPeriod,
  type CashFlowPeriod,
  type RelativeCashFlowPeriod,
} from "@/lib/transactions/cash-flow";

interface Props {
  value:      CashFlowPeriod;
  onChange:   (period: CashFlowPeriod) => void;
  className?: string;
}

const TO_DATE_IDS = new Set<RelativeCashFlowPeriod>(TO_DATE_PERIODS.map((p) => p.id));
const ROLLING_IDS = new Set<RelativeCashFlowPeriod>(ROLLING_PERIODS.map((p) => p.id));

export function CashFlowPeriodSelector({ value, onChange, className = "" }: Props) {
  // One group holds the active segment at a time; an empty value matches no
  // option, so the other group (and an explicit historical period) shows no
  // highlight — exactly what we want.
  const relValue     = isExplicitPeriod(value) ? undefined : value;
  const toDateValue  = (relValue && TO_DATE_IDS.has(relValue) ? relValue : "") as RelativeCashFlowPeriod;
  const rollingValue = (relValue && ROLLING_IDS.has(relValue) ? relValue : "") as RelativeCashFlowPeriod;

  return (
    <div className={["flex flex-wrap items-center justify-between gap-2", className].join(" ")}>
      <SegmentedControl
        aria-label="Cash flow period — to date"
        options={TO_DATE_PERIODS}
        value={toDateValue}
        onChange={onChange}
      />
      <SegmentedControl
        aria-label="Cash flow period — rolling"
        options={ROLLING_PERIODS}
        value={rollingValue}
        onChange={onChange}
      />
    </div>
  );
}
