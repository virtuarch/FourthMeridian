"use client";

/**
 * components/platform/incidents/AiAssessmentSection.tsx  (Incident drawer PR-D — the "AI assessment" disclosure; S2 09gg (d))
 *
 * IncidentsLead.tsx `slots.aiAssessment`. Renders NOTHING unless the server's detail DTO says
 * `aiAssessmentAvailable: true` (the incidents pack flag). Collapsed by default; never automatic — the
 * operator presses "Assess" (one Platform AI turn). Shows the five server-written answers; a "Likely: …"
 * answer is marked as a hypothesis. Refusals (limit reached, unavailable) are one quiet line. Nothing is
 * stored: closing the drawer forgets the assessment.
 */

import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { IncidentDetailDTO, IncidentTier } from "@/lib/platform/incidents/investigation-dto";
import {
  ASSESSMENT_QUIET, assessmentAvailable, assessmentQuietLine, incidentAssessmentPath, isHypothesis, parseAssessment, type IncidentAssessment,
} from "./ai-assessment-model";

const H = "text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]";
const BTN = "inline-flex min-h-11 min-w-0 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-3 text-xs text-[var(--text-secondary)] disabled:opacity-50 lg:min-h-8";

export type AssessmentState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; assessment: IncidentAssessment }
  | { kind: "quiet"; line: string };

/** PROP-DRIVEN: every state renders in a test (incident-ai-assessment.test.ts). */
export function AiAssessmentSurface({ state, onAssess, open }: { state: AssessmentState; onAssess: () => void; open?: boolean }) {
  const a = state.kind === "done" ? state.assessment : null;
  return (
    <details className="group min-w-0 border-t border-[var(--border-hairline)] pt-3" data-ai-assessment open={open || undefined}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-90" />
        <span className={H}>AI assessment</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">{a ? "Assessed" : "On request"}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pb-1 pt-2">
        <p className="break-words text-[11px] text-[var(--text-muted)]">
          Platform AI summarises this incident from its recorded codes. The facts below are written by the server; nothing is saved.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} onClick={onAssess} disabled={state.kind === "busy"} data-ai-assessment-assess>
            <Sparkles size={12} aria-hidden className="shrink-0" />
            {state.kind === "busy" ? "Assessing…" : a ? "Assess again" : "Assess"}
          </button>
        </div>
        {state.kind === "quiet" && <p role="status" className="break-words text-[11px] text-[var(--text-muted)]" data-ai-assessment-quiet>{state.line}</p>}
        {a && (
          <div className="flex min-w-0 flex-col gap-2" data-ai-assessment-result>
            {a.framing && <p className="break-words text-xs text-[var(--text-secondary)]" data-ai-assessment-framing>{a.framing}</p>}
            <dl className="flex min-w-0 flex-col gap-2">
              {a.answers.map((x) => {
                const hyp = isHypothesis(x);
                return (
                  <div key={x.key} className="min-w-0" data-ai-assessment-answer={x.key} data-hypothesis={hyp ? "yes" : undefined}>
                    <dt className="text-[11px] text-[var(--text-faint)]">{x.question}</dt>
                    <dd className={`break-words text-xs ${hyp ? "italic text-[var(--text-muted)]" : "text-[var(--text-primary)]"}`}>
                      {hyp && <span className="mr-1 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-1 text-[10px] not-italic text-[var(--text-faint)]">Hypothesis</span>}
                      {x.text}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </div>
        )}
      </div>
    </details>
  );
}

/** The container: one POST per "Assess" click; nothing on mount. */
function AiAssessmentContainer({ tier, id }: { tier: IncidentTier; id: string }) {
  const [state, setState] = useState<AssessmentState>({ kind: "idle" });
  async function assess() {
    setState({ kind: "busy" });
    try {
      const r = await fetch(incidentAssessmentPath(tier, id), { method: "POST", credentials: "same-origin" });
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      const parsed = r.ok ? parseAssessment(body) : null;
      setState(parsed ? { kind: "done", assessment: parsed } : { kind: "quiet", line: r.ok ? ASSESSMENT_QUIET.failed : assessmentQuietLine(r.status, body) });
    } catch {
      setState({ kind: "quiet", line: ASSESSMENT_QUIET.failed });
    }
  }
  return <AiAssessmentSurface state={state} onAssess={assess} />;
}

/** The drawer slot: NOTHING unless the server says the assessment exists for this viewer. */
export function IncidentAiAssessment({ tier, d }: { tier: IncidentTier; d: IncidentDetailDTO }) {
  if (!assessmentAvailable(d) || d.tier !== tier) return null;
  return <AiAssessmentContainer key={d.incident.id} tier={tier} id={d.incident.id} />;
}
