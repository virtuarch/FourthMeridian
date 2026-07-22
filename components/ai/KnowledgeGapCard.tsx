/**
 * components/ai/KnowledgeGapCard.tsx  (AI Experience Convergence — AI-1)
 *
 * The presentation frame for a knowledge-gap prompt inside an answer: a quiet
 * grounding eyebrow above the interactive content. It is a PURE presentation wrapper
 * — it deliberately does NOT re-implement the gap form. The live, API-calling
 * `KnowledgeAcquisitionCard` (dual-consumed by the debt widget) is reused in place
 * and passed in as `children`, so `components/ai/` stays free of API calls and the
 * coupling point is never moved.
 */

import type { ReactNode } from "react";

export function KnowledgeGapCard({
  label = "Sharpen this answer",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
        {label}
      </p>
      {children}
    </div>
  );
}
