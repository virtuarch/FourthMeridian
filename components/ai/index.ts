/**
 * components/ai/index.ts  (AI Experience Convergence — AI-1)
 *
 * The AI presentation layer barrel. Every component here is presentation-only: it
 * consumes props, makes no API calls, performs no financial calculation, and imports
 * no workspace/runtime code. The orchestrator (AnalyzeClient) owns all data + state.
 */

export { AiShell, type AiShellProps } from "@/components/ai/AiShell";
export { ConversationView, type ConversationViewProps } from "@/components/ai/ConversationView";
export { MessageCard } from "@/components/ai/MessageCard";
export { AnswerCard, type AnswerCardProps } from "@/components/ai/AnswerCard";
export { Composer, type ComposerProps } from "@/components/ai/Composer";
export { SuggestedPrompt } from "@/components/ai/SuggestedPrompt";
export { KnowledgeGapCard } from "@/components/ai/KnowledgeGapCard";
export { AiMark } from "@/components/ai/AiMark";
export { Markdown } from "@/components/ai/Markdown";
export type { AiMessage } from "@/components/ai/types";
