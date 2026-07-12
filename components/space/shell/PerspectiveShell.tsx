"use client";

/**
 * components/space/shell/PerspectiveShell.tsx
 *
 * The Perspective shell as ONE visual object — two framed containers, then the
 * workspace below (rendered by the host). It reads as "time and trust remain
 * fixed; the lens changes":
 *
 *   Container 2 — "the lens" (lighter, --border-hairline):
 *     PerspectiveTabs (one SegmentedControl track)
 *   Container 1 — "time & trust" (heaviest chrome, --border-hairline-strong):
 *     Row A  ShellContextRow (As of · ⇄ · Compare to · Completeness · Evidence)
 *     Row B  the preset segmented controls (to-date left · rolling right)
 *
 * SHELL_NAV redesign (§2.2): the lens tab track now sits ABOVE the time/trust +
 * period-preset block — you pick the lens first, then read/adjust time beneath
 * it. Container numbering keeps its original semantics (1 = time & trust, 2 =
 * the lens); only the render order swapped.
 *
 * The shell writes shell state only through its own controls; perspectives read
 * context and never own time. Presentation only.
 */

import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import { CashFlowPeriodSelector } from "@/components/space/widgets/CashFlowPeriodSelector";
import { FloatingNavWrapper, PERSPECTIVE_PILL_TOP } from "@/components/atlas/FloatingNavWrapper";
import { ShellContextRow } from "./ShellContextRow";
import { PerspectiveTabs, type PerspectiveTabItem } from "./PerspectiveTabs";

interface Props {
  // Row A — time & trust context.
  asOf:              string;
  compareTo:         string | null;
  today:             string;
  onAsOfChange:      (v: string) => void;
  onCompareToChange: (v: string | null) => void;
  onSwap:            () => void;
  /** The active perspective's trust envelope (from the S3 registry). */
  envelope:          PerspectiveEnvelope;
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
      {/* Container 2 — the lens. Now rendered FIRST (SHELL_NAV §2.2: pick the
          lens above, read/adjust time below) and as a centered FLOATING pill
          (§2.4) rather than a bordered selector frame — the SegmentedControl
          supplies its own glass material, so the old border box is dropped. */}
      <FloatingNavWrapper top={PERSPECTIVE_PILL_TOP}>
        <PerspectiveTabs items={props.tabs} activeId={props.activeTabId} onSelect={props.onSelectTab} />
      </FloatingNavWrapper>

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
          envelope={props.envelope}
        />
        <div className="border-t" style={{ borderColor: "var(--border-hairline)" }} aria-hidden />
        <CashFlowPeriodSelector value={props.presetValue} onChange={props.onSelectPreset} />
      </div>
    </div>
  );
}
