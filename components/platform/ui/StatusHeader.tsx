/**
 * components/platform/ui/StatusHeader.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * One line of verdict + when it was checked + 3–4 compact facts. The verdict is
 * a WORD with its dot (ToneBadge — never colour alone) supplied by the caller's
 * authority; this primitive derives nothing. A muted tone is the honest default
 * for "no verdict": the primitive has no "healthy" fallback.
 */

import type { ReactNode } from "react";
import { Surface } from "@/components/atlas/Surface";
import { ToneBadge, TONE_COLOR, type StatusTone } from "@/components/platform/platform-surface";
import { utcClock } from "./ProvenanceChip";

export interface StatusFact {
  label: string;
  value: ReactNode;
  tone?: StatusTone;
}

export function StatusHeader({
  verdict,
  title,
  checkedAt,
  facts = [],
  aside,
}: {
  /** The verdict word + tone, from the caller's authority. */
  verdict: { word: string; tone: StatusTone };
  /** One sentence beside the verdict. */
  title: string;
  /** ISO instant the verdict was derived; omitted ⇒ no "checked" claim. */
  checkedAt?: string | null;
  /** At most four are shown. */
  facts?: readonly StatusFact[];
  /** A slot for a provenance chip or a quiet note. */
  aside?: ReactNode;
}) {
  const clock = utcClock(checkedAt);
  return (
    <Surface as="section" className="flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ToneBadge word={verdict.word} tone={verdict.tone} />
        {clock && <span className="text-[11px] text-[var(--text-muted)]">Checked {clock}</span>}
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      <h2 className="text-lg font-semibold leading-snug text-[var(--text-primary)] sm:text-xl">{title}</h2>
      {facts.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {facts.slice(0, 4).map((f) => (
            <div key={f.label} className="flex min-w-0 flex-col gap-0.5">
              <dt className="truncate text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{f.label}</dt>
              <dd className="truncate text-sm font-medium tabular-nums" style={{ color: f.tone ? TONE_COLOR[f.tone] : "var(--text-primary)" }}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Surface>
  );
}
