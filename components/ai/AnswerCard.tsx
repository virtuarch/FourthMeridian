/**
 * components/ai/AnswerCard.tsx  (AI Experience Convergence — AI-1)
 *
 * The grounded AI answer: the AI mark in a left gutter + the answer prose, with an
 * `extras` slot below (today: the knowledge-gap prompt supplied by the orchestrator).
 *
 * FUTURE-READY, HONEST CONTRACT: the v2.6 slots (`facts`/`evidence`/`actions`/
 * `relatedEntities`) exist in the type so the component can widen without a rewrite,
 * but they are typed `never[]` — impossible to populate against today's API — and
 * NOTHING is rendered for them. The card shows only what the backend actually
 * returns: the `message` and the knowledge-gap extras. No empty or fabricated
 * sections. Presentation only — no fetch, no calculation.
 */

import type { ReactNode } from "react";
import { AiMark } from "@/components/ai/AiMark";
import { Markdown } from "@/components/ai/Markdown";

export type AnswerCardProps = {
  /** The answer body (Markdown). Includes any inlined validation notice from the API. */
  message: string;
  /** Extras rendered below the answer — today, the knowledge-gap prompt. */
  children?: ReactNode;
  // ── v2.6 future slots — present in the contract, un-populatable today ──
  facts?: never[];
  evidence?: never[];
  actions?: never[];
  relatedEntities?: never[];
};

export function AnswerCard({ message, children }: AnswerCardProps) {
  return (
    <div className="flex gap-3">
      <div className="pt-1.5 shrink-0">
        <AiMark />
      </div>
      <div className="min-w-0 flex-1 space-y-2.5 text-sm" style={{ color: "var(--text-secondary)" }}>
        <div className="leading-relaxed">
          <Markdown>{message}</Markdown>
        </div>
        {children}
      </div>
    </div>
  );
}
