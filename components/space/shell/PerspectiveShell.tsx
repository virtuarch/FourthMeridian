"use client";

/**
 * components/space/shell/PerspectiveShell.tsx
 *
 * The Perspective shell as ONE visual object — two framed containers, then the
 * workspace below (rendered by the host). It reads as "time and trust remain
 * fixed; the lens changes":
 *
 *   Container 1 — "time & trust" (heaviest chrome, --border-hairline-strong):
 *     Row A  ShellContextRow (As of · ⇄ · Compare to · Completeness · Evidence)
 *     Row B  the preset segmented controls (to-date left · rolling right)
 *   Container 2 — "the lens" (lighter, --border-hairline):
 *     PerspectiveTabs (one SegmentedControl track)
 *
 * The shell writes shell state only through its own controls; perspectives read
 * context and never own time. Presentation only.
 */

import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import { CashFlowPeriodSelector } from "@/components/space/widgets/CashFlowPeriodSelector";
import { ShellContextRow, type CompletenessSummary, type EvidenceSummary } from "./ShellContextRow";
import { PerspectiveTabs, type PerspectiveTabItem } from "./PerspectiveTabs";

interface Props {
  // Row A — time & trust context.
  asOf:              string;
  compareTo:         string | null;
  today:             string;
  onAsOfChange:      (v: string) => void;
  onCompareToChange: (v: string | null) => void;
  onSwap:            () => void;
  completeness?:     CompletenessSummary;
  evidence?:         EvidenceSummary;
  // Row B — presets (value is null under CUSTOM: no segment highlighted).
  presetValue:    CashFlowPeriod | null;
  onSelectPreset: (p: CashFlowPeriod) => void;
  // Container 2 — the lens.
  tabs:        PerspectiveTabItem[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
}

export function PerspectiveShell(props: Props) {
  return (
    <div className="space-y-3">
      {/* Container 1 — time & trust (the permanent instrument panel). */}
      <div
        className="rounded-2xl border p-3 sm:p-4 space-y-3"
        style={{
          background: "var(--glass-ultrathin)",
          borderColor: "var(--border-hairline-strong)",
          backdropFilter: "blur(30px) saturate(160%)",
          WebkitBackdropFilter: "blur(30px) saturate(160%)",
        }}
      >
        <ShellContextRow
          asOf={props.asOf}
          onAsOfChange={props.onAsOfChange}
          compareTo={props.compareTo}
          onCompareToChange={props.onCompareToChange}
          onSwap={props.onSwap}
          today={props.today}
          completeness={props.completeness}
          evidence={props.evidence}
        />
        <div className="border-t" style={{ borderColor: "var(--border-hairline)" }} aria-hidden />
        <CashFlowPeriodSelector value={props.presetValue} onChange={props.onSelectPreset} />
      </div>

      {/* Container 2 — the lens (a lighter selector frame). */}
      <div
        className="rounded-2xl border p-1.5 sm:p-2"
        style={{ borderColor: "var(--border-hairline)" }}
      >
        <PerspectiveTabs items={props.tabs} activeId={props.activeTabId} onSelect={props.onSelectTab} />
      </div>
    </div>
  );
}
