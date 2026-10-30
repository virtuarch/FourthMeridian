/**
 * components/platform/PlatformAiPlaceholder.tsx  (Platform Operations 2.0 — R1)
 *
 * The Platform AI destination, honestly empty. The Personal AI page's visual
 * language (the AiMark header, the centred starter headline, the reading
 * column) with NOTHING that pretends to work: no composer, no text input, no
 * suggested prompts, no messages, no buttons. One status word (dot + word) and
 * one short paragraph that says what is planned and that it is not available.
 *
 * Server Component: no state, no fetch, no client JS.
 */

import { AiMark } from "@/components/ai/AiMark";
import { ToneBadge } from "@/components/platform/platform-surface";

export const PLATFORM_AI_TITLE = "Platform AI";

export const PLATFORM_AI_COPY =
  "Planned: read-only intelligence over Platform data — answers about jobs, providers, costs and customer operations, drawn from the same records these Spaces show. Any operational action it suggests will require your explicit authorisation. It is not available yet.";

export function PlatformAiPlaceholder() {
  return (
    <div className="flex min-h-[60vh] min-w-0 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 pb-3">
        <AiMark />
        <h1 className="text-base font-semibold leading-tight text-[var(--text-primary)]">{PLATFORM_AI_TITLE}</h1>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-1 py-10 text-center">
        <ToneBadge word="Not available yet" tone="muted" />
        <h2 className="text-balance text-2xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-[28px]">
          Ask about the platform, soon.
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-[var(--text-secondary)]">{PLATFORM_AI_COPY}</p>
      </div>
    </div>
  );
}
