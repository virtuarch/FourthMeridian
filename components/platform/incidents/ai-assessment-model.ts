/**
 * components/platform/incidents/ai-assessment-model.ts  (Incident drawer PR-D — the AI assessment's view-model; PURE)
 *
 * The drawer's "AI assessment" disclosure reads ONE route per tier (POST …/incidents/[id]/assessment,
 * lib/platform/intelligence/ai/assessment/incident.ts). Availability comes from the server
 * (`aiAssessmentAvailable` on the detail DTO — the incidents pack flag); this file never decides it.
 * Refusals map to ONE quiet line each (restrained wording; no codes, no figures).
 */

import type { IncidentDetailDTO, IncidentTier } from "@/lib/platform/incidents/investigation-dto";
import type { AssessmentAnswer, IncidentAssessment } from "@/lib/platform/intelligence/ai/assessment/incident";
import { incidentDetailApiPath } from "./incidents-url";

export type { AssessmentAnswer, IncidentAssessment };

export function incidentAssessmentPath(tier: IncidentTier, id: string): string {
  return `${incidentDetailApiPath(tier, id)}/assessment`;
}

/** The server's flag only: absent / anything but `true` ⇒ the assessment does not exist for this viewer. */
export const assessmentAvailable = (d: Pick<IncidentDetailDTO, "aiAssessmentAvailable">): boolean => d.aiAssessmentAvailable === true;

export const ASSESSMENT_QUIET = {
  limit: "Platform AI's daily limit is reached. Try again tomorrow.",
  busy: "Too many requests. Wait a minute and try again.",
  unavailable: "Platform AI is unavailable right now.",
  notFound: "No assessment is available for this incident.",
  failed: "The assessment couldn't be completed.",
} as const;

/** One quiet line for a refused / failed assessment. */
export function assessmentQuietLine(status: number, body: Record<string, unknown> | null): string {
  if (status === 429) return body?.code === "DAILY_TURNS" || body?.code === "COST_CAP" ? ASSESSMENT_QUIET.limit : ASSESSMENT_QUIET.busy;
  if (status === 503) return ASSESSMENT_QUIET.unavailable;
  if (status === 404) return ASSESSMENT_QUIET.notFound;
  return ASSESSMENT_QUIET.failed;
}

/** A 200 body that is a well-formed assessment (five answers with text), or null. */
export function parseAssessment(body: unknown): IncidentAssessment | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Partial<IncidentAssessment>;
  if (!Array.isArray(b.answers) || b.answers.length !== 5 || !b.answers.every((a) => a && typeof a.text === "string" && typeof a.question === "string")) return null;
  return { answers: b.answers, framing: typeof b.framing === "string" ? b.framing : null, verifiedRecovery: b.verifiedRecovery === true, checkedAt: String(b.checkedAt ?? "") };
}

/** "Likely: …" — the answer is a hypothesis (the server flags it; the prefix is a fallback). */
export const isHypothesis = (a: Pick<AssessmentAnswer, "hypothesis" | "text">): boolean => a.hypothesis === true || /^likely:/i.test(a.text);
