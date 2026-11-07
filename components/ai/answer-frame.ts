/**
 * components/ai/answer-frame.ts  (parity PR3)
 *
 * The answer frame (AI-mark gutter + answer prose + extras) under a name of its
 * own, for surfaces that bring their OWN renderer and must not name the
 * Markdown answer component at all (Platform AI: typed segments only, pinned by
 * components/platform/platform-ai-conversations.test.ts). The frame itself
 * stays in its pinned file; this is a re-export, not a copy.
 */

export { AnswerFrame } from "@/components/ai/AnswerCard";
