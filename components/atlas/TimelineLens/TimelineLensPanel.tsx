"use client";

/**
 * components/atlas/TimelineLens/TimelineLensPanel.tsx
 *
 * The editing surface. LeftPanel because this is context/control — "what am I
 * operating in?" — not right-side drill-down detail (see components/atlas/panels
 * SidePanels doctrine, and WorkspaceLayout's `<LeftPanel open={filtersOpen}>`).
 *
 * Focus trap, Escape, scroll lock, focus restoration, scrim, mobile bottom sheet,
 * grab handle, safe-area footer, and reduced motion all come from Panel. Nothing
 * overlay-related is reimplemented here.
 */

import { useId, type KeyboardEvent } from "react";
import { ArrowLeftRight, Check, X } from "lucide-react";
import { GlassButton } from "@/components/atlas/GlassButton";
import { Field, Input } from "@/components/atlas/fields";
import { LeftPanel, PanelContent, PanelFooter, PanelHeader } from "@/components/atlas/panels";
import type {
  TimelineIntent,
  TimelineLensCapability,
  TimelineLensSummary,
  TimelinePeriodOption,
} from "./types";

interface Props {
  open: boolean;
  activeOptionId: string | null;
  boundaries: { asOf: string; compareTo: string };
  summary: TimelineLensSummary;
  periodOptions: readonly TimelinePeriodOption[];
  capability: TimelineLensCapability;
  maxDate: string;
  boundaryError: string | null;
  onIntent: (intent: TimelineIntent) => void;
  onClose: () => void;
}

/** Visual subsections of ONE logical choice. Render order defines keyboard order. */
const GROUPS = [
  { key: "toDate" as const, title: "To date" },
  { key: "rolling" as const, title: "Rolling" },
];

/**
 * Roving focus across the whole period choice. Arrow keys move and select
 * (selection-follows-focus, the standard radiogroup pattern); Home/End jump to
 * the ends. There is exactly ONE radiogroup, so focus traverses every option and
 * cannot be stranded in a subsection whose selection lives in the other.
 */
function onRadioKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;

  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])'),
  );
  if (radios.length === 0) return;

  const current = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();

  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = radios.length - 1;
  else {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    next = (current + delta + radios.length) % radios.length;
  }

  radios[next].focus();
  radios[next].click();
}

function PeriodRadio({
  option,
  selected,
  tabbable,
  onSelect,
}: {
  option: TimelinePeriodOption;
  selected: boolean;
  tabbable: boolean;
  onSelect: () => void;
}) {
  return (
    <GlassButton
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabbable ? 0 : -1}
      tone={selected ? "meridian" : "neutral"}
      size="sm"
      onClick={onSelect}
      className="min-h-[52px] w-full justify-between gap-2 text-left"
    >
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-xs font-semibold">{option.label}</span>
        {option.supportingLabel && (
          <span className="truncate text-[11px] font-normal text-[var(--text-faint)]">
            {option.supportingLabel}
          </span>
        )}
      </span>
      {selected && <Check size={14} aria-hidden className="shrink-0" />}
    </GlassButton>
  );
}

export function TimelineLensPanel({
  open,
  activeOptionId,
  boundaries,
  summary,
  periodOptions,
  capability,
  maxDate,
  boundaryError,
  onIntent,
  onClose,
}: Props) {
  const asOfId = useId();
  const compareToId = useId();
  const groupId = useId();

  // Flattened in render order so the roving-tabindex fallback is deterministic.
  const ordered = GROUPS.flatMap((group) => periodOptions.filter((option) => option.group === group.key));

  // Fallback matters: under a custom range NO option is selected, and without
  // this every radio would be tabIndex -1 and the whole group unreachable.
  const tabbableId = activeOptionId ?? ordered[0]?.id ?? null;

  const hasComparison = boundaries.compareTo !== "";

  return (
    <LeftPanel open={open} onClose={onClose} size="md" ariaLabel="Time period">
      <PanelHeader eyebrow="Perspective" title="Time period" />

      <PanelContent className="pt-1">
        <div role="radiogroup" aria-labelledby={groupId} onKeyDown={onRadioKeyDown} className="grid gap-6">
          <h3 id={groupId} className="sr-only">
            Time period
          </h3>
          {GROUPS.map((group) => {
            const options = periodOptions.filter((option) => option.group === group.key);
            if (options.length === 0) return null;
            return (
              <section key={group.key} className="grid gap-2">
                <h4
                  aria-hidden
                  className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]"
                >
                  {group.title}
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  {options.map((option) => (
                    <PeriodRadio
                      key={option.id}
                      option={option}
                      selected={option.id === activeOptionId}
                      tabbable={option.id === tabbableId}
                      onSelect={() =>
                        onIntent({ type: "period", optionId: option.id, intent: option.intent })
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {capability.custom && (
          <section className="mt-7 grid gap-2 border-t border-[var(--border-hairline)] pt-6">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-faint)]">
                Exact boundaries
              </h4>
              {capability.comparison && (
                <div className="flex items-center gap-1">
                  <GlassButton
                    type="button"
                    tone="neutral"
                    size="sm"
                    disabled={!hasComparison}
                    onClick={() => onIntent({ type: "swap" })}
                    aria-label="Swap the two boundary dates"
                    className="!px-2"
                  >
                    <ArrowLeftRight size={13} aria-hidden />
                  </GlassButton>
                  <GlassButton
                    type="button"
                    tone="neutral"
                    size="sm"
                    disabled={!hasComparison}
                    onClick={() => onIntent({ type: "clearComparison" })}
                    aria-label="Clear the comparison boundary"
                    className="!px-2"
                  >
                    <X size={13} aria-hidden />
                  </GlassButton>
                </div>
              )}
            </div>

            {/*
              `max` on BOTH fields mirrors the production controls. It is an input
              constraint only — there is deliberately no cross-field min/max, so a
              comparison boundary AFTER the as-of date stays expressible. Whether
              that is meaningful is the consumer's call, not this component's.
            */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Compare to" htmlFor={compareToId} error={boundaryError}>
                <Input
                  id={compareToId}
                  type="date"
                  value={boundaries.compareTo}
                  max={maxDate}
                  onChange={(event) =>
                    onIntent({ type: "customBoundary", boundary: "compareTo", value: event.target.value })
                  }
                />
              </Field>
              <Field label="As of" htmlFor={asOfId}>
                <Input
                  id={asOfId}
                  type="date"
                  value={boundaries.asOf}
                  max={maxDate}
                  onChange={(event) =>
                    onIntent({ type: "customBoundary", boundary: "asOf", value: event.target.value })
                  }
                />
              </Field>
            </div>
          </section>
        )}
      </PanelContent>

      <PanelFooter className="flex items-center justify-between gap-3">
        {/* Live readout: changes apply immediately, so this is how a boundary edit
            shows its effect without closing the panel. */}
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-xs text-[var(--text-primary)]">{summary.periodLabel}</span>
          <span className="truncate text-[11px] tabular-nums text-[var(--text-muted)]">
            {summary.rangeLabel}
          </span>
        </span>
        <GlassButton type="button" tone="meridian" size="md" onClick={onClose} className="shrink-0">
          Done
        </GlassButton>
      </PanelFooter>
    </LeftPanel>
  );
}
