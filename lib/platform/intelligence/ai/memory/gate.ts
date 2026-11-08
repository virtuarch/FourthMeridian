/**
 * lib/platform/intelligence/ai/memory/gate.ts  (Platform AI operational memory — the ONE effective check)
 *
 * Design v2 §6 / D1: memory is effective only when env.isPlatformAiMemoryEnabled
 * (Platform AI + conversations + the conversation purge + the memory purge + the
 * memory flag, all strict "true") AND the transcript retention in code is at most
 * 7 days. The 7-day retention as the DATABASE holds it is verified by the
 * read-only pre-enable check (npm run report:platform-ai-memory-precheck) before
 * the flag is set. Every memory route checks this FIRST (404 otherwise), and the
 * tools and the turn injection exist only when it is true.
 */

import { PLATFORM_AI_RETENTION_DAYS } from "../conversations/constants";

/** The retention ceiling memory requires (D1). */
export const MEMORY_REQUIRED_RETENTION_DAYS = 7;

export function isMemoryEffective(env: { isPlatformAiMemoryEnabled: boolean }, retentionDays: number = PLATFORM_AI_RETENTION_DAYS): boolean {
  return env.isPlatformAiMemoryEnabled === true && retentionDays <= MEMORY_REQUIRED_RETENTION_DAYS;
}
