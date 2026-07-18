/**
 * components/ai/types.ts  (AI Experience Convergence — AI-1)
 *
 * Presentation types for the AI conversation surface. Deliberately MINIMAL — the
 * `components/ai/` layer knows only what it renders, never the AI domain. The
 * orchestrator maps its richer message model onto this shape.
 */

/** One conversation turn, as far as presentation is concerned. */
export interface AiMessage {
  role: "user" | "assistant";
  content: string;
}
