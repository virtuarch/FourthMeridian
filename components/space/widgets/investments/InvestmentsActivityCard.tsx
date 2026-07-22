"use client";

/**
 * components/space/widgets/investments/InvestmentsActivityCard.tsx
 *
 * Thin renderer over `buildActivityGroups` (the pure model). Shows the period's
 * intent-grouped flows as deterministic template sentences — money in, money
 * out, and inside-the-portfolio — plus one caveat line built from the honesty
 * counters. The no-comparison and no-events states come straight from the model
 * (honest copy, never a fabricated window). This card holds no state and does no
 * arithmetic; every number and sentence is the model's.
 */

import { ArrowDownLeft, ArrowUpRight, Repeat } from "lucide-react";
import type { PeriodFlows } from "@/lib/investments/investment-flows-core";
import { buildActivityGroups, type ActivityGroupKey } from "./investments-activity";

const GROUP_ICON: Record<ActivityGroupKey, typeof ArrowDownLeft> = {
  money_in:  ArrowDownLeft,
  money_out: ArrowUpRight,
  inside:    Repeat,
};

export function InvestmentsActivityCard({ flows }: { flows: PeriodFlows | null }) {
  const model = buildActivityGroups(flows);

  if (model.state !== "events") {
    return <p className="text-sm py-4" style={{ color: "var(--text-muted)" }}>{model.message}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      {model.groups.map((g) => {
        const Icon = GROUP_ICON[g.key];
        return (
          <div key={g.key} className="flex items-start gap-2.5">
            <Icon size={15} className="shrink-0 mt-0.5" style={{ color: "var(--text-secondary)" }} aria-hidden />
            <p className="text-sm min-w-0" style={{ color: "var(--text-primary)" }}>{g.sentence}</p>
          </div>
        );
      })}
      {model.caveat && (
        <p className="text-xs mt-1 pt-2 border-t" style={{ color: "var(--text-muted)", borderColor: "var(--border-hairline)" }}>
          {model.caveat}
        </p>
      )}
    </div>
  );
}
