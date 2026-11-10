/**
 * components/ui/chrome-surface.ts  (pure; parity PR2)
 *
 * Which routes the dashboard chrome lays out as a full-height CONVERSATION page,
 * and — a separate question — where the notice rail withholds the 2FA reminder.
 *
 *   layout   — Personal Space AI (/dashboard/analyze, the existing AI destination
 *              rule) AND Platform AI (/dashboard/platform/ai). <main> pads by
 *              exactly the bottom bar's footprint and AiShell owns the viewport.
 *   notices  — Personal Space AI ONLY (AI-4, unchanged). S2 ruling 2026-11-07:
 *              the 2FA reminder is NOT hidden by path on Platform AI; its own
 *              TOTP condition decides. The rail publishes its height
 *              (--fm-notice-rail-h) and AiShell subtracts it, so the shell
 *              leaves room for the banner when it renders.
 */

import { isPrimaryDestActive } from "@/lib/space-nav";
import { isPlatformAiPath } from "@/lib/platform/nav";

export interface ChromeSurface {
  /** Full-height conversation layout (main padding = bottom-bar footprint). */
  conversationLayout: boolean;
  /** Passed to the NoticeRail: withhold the 2FA reminder / invitation (Personal AI only). */
  noticeConversationSurface: boolean;
}

export function chromeSurface(pathname: string): ChromeSurface {
  const personalAi = isPrimaryDestActive("ai", pathname);
  return {
    conversationLayout: personalAi || isPlatformAiPath(pathname),
    noticeConversationSurface: personalAi,
  };
}
