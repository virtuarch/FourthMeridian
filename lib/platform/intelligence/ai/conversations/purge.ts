/**
 * lib/platform/intelligence/ai/conversations/purge.ts  (Platform AI conversations — the retention rule)
 *
 * Design §7.2 / §7.4 R6. The retention job runs as fm_system, which holds NO
 * grant on either conversation table (S2 B4). It reaches them only through
 * `fm_purge_platform_ai_conversations(p_limit)` — SECURITY DEFINER, fixed
 * predicates, counts in and counts out (migration 20261104120000). fm_system
 * cannot choose which rows die and never sees an id, a timestamp or content.
 *
 * ⚠️ SHIPS DISABLED. `PLATFORM_AI_PURGE_ENABLED` (lib/env.ts) defaults OFF; while
 * off this rule makes NO database contact. It is switched on together with
 * storage, only after S2's final retention clearance (OD-7 ruled 2026-11-04) and the Preview
 * pre-enable check passes (scripts/platform-ai-conversations-precheck.ts).
 * Storage is never on without the purge (design §13 activation order).
 *
 *   · Batch-bounded: ≤ PLATFORM_AI_PURGE_BATCH conversations and
 *     ≤ PLATFORM_AI_PURGE_BATCH × PLATFORM_AI_PURGE_EXCHANGE_FACTOR expired
 *     exchanges per call; ≤ PLATFORM_AI_PURGE_MAX_CALLS calls per run, then
 *     "more remain" (exhausted: false) and tomorrow's run continues.
 *   · Audited counts only: one AuditLog row PLATFORM_AI_CONVERSATIONS_PURGED per
 *     run with a non-zero count (per run, zero included, for the manual
 *     dispatch — auditEveryRun) — { conversations, messages, batches, exhausted },
 *     no userId, no content.
 *   · Fail-safe: a throwing call stops THIS rule only (reported as `error`),
 *     deletes nothing it did not already delete, and never blocks the other
 *     retention rules (jobs/data-retention.ts catches each rule on its own).
 *
 * Pure orchestration over injected seams (the call and the audit write), so
 * the unit test drives it without a database; the real seams are wired in
 * jobs/data-retention.ts against systemDb.
 */

import { AuditAction } from "@/lib/audit-actions";
import { PLATFORM_AI_PURGE_BATCH, PLATFORM_AI_PURGE_EXCHANGE_FACTOR, PLATFORM_AI_PURGE_MAX_CALLS } from "./constants";

export interface PlatformAiPurgeCounts { conversations: number; messages: number }

export interface PlatformAiPurgeResult {
  /** False ⇒ the flag is off and nothing was contacted. */
  enabled: boolean;
  conversations: number;
  messages: number;
  batches: number;
  /** True when the last call saturated neither bound (nothing more expired right now). */
  exhausted: boolean;
  error?: string;
}

export interface PlatformAiPurgeDeps {
  enabled: boolean;
  /** One call of the definer function: `SELECT * FROM fm_purge_platform_ai_conversations($limit)`. */
  call(limit: number): Promise<PlatformAiPurgeCounts>;
  /** One AuditLog row (fm_system INSERT): counts only. */
  audit(detail: { conversations: number; messages: number; batches: number; exhausted: boolean }): Promise<void>;
  /**
   * Write the counts-only audit row even when nothing was purged. The manual
   * dispatch (scripts/platform-ai-conversations-purge-dispatch.ts — Preview runs
   * no crons) sets it so every dispatch leaves proof of the cadence; the
   * scheduled job leaves it unset (a row only when something was removed).
   */
  auditEveryRun?: boolean;
}

/** The SQL the real seam runs — the ONLY statement fm_system issues against this feature. */
export const PLATFORM_AI_PURGE_SQL = `SELECT conversations, messages FROM public.fm_purge_platform_ai_conversations($1::integer)`;

export const PLATFORM_AI_PURGE_AUDIT_ACTION = AuditAction.PLATFORM_AI_CONVERSATIONS_PURGED;

const asCount = (v: unknown): number => {
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error("purge function returned a non-count");
  return n;
};

/** Normalise the function's one returned row (counts only; anything else is refused). */
export function parsePurgeRow(rows: unknown): PlatformAiPurgeCounts {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new Error("purge function returned an unexpected shape");
  const r = rows[0] as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== "conversations,messages") throw new Error("purge function returned an unexpected shape");
  return { conversations: asCount(r.conversations), messages: asCount(r.messages) };
}

export async function runPlatformAiConversationPurge(deps: PlatformAiPurgeDeps): Promise<PlatformAiPurgeResult> {
  const out: PlatformAiPurgeResult = { enabled: deps.enabled, conversations: 0, messages: 0, batches: 0, exhausted: false };
  if (!deps.enabled) return out;
  try {
    while (out.batches < PLATFORM_AI_PURGE_MAX_CALLS) {
      const r = await deps.call(PLATFORM_AI_PURGE_BATCH);
      out.batches++;
      out.conversations += r.conversations;
      out.messages += r.messages;
      // Step 1 deletes ≤ limit × factor USER rows (each counted in `messages`);
      // step 2 deletes ≤ limit conversations. Below both bounds ⇒ nothing more expired.
      if (r.conversations < PLATFORM_AI_PURGE_BATCH && r.messages < PLATFORM_AI_PURGE_BATCH * PLATFORM_AI_PURGE_EXCHANGE_FACTOR) {
        out.exhausted = true;
        break;
      }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    console.error("[data-retention] platform-ai-conversations purge failed (others continue)");
  }
  if (out.conversations > 0 || out.messages > 0 || deps.auditEveryRun) {
    try {
      await deps.audit({ conversations: out.conversations, messages: out.messages, batches: out.batches, exhausted: out.exhausted });
    } catch {
      console.error("[data-retention] platform-ai-conversations purge audit row failed");
    }
    console.log(`[data-retention] platform-ai-conversations: purged ${out.conversations} conversation(s), ${out.messages} message(s)${out.exhausted ? "" : " (more remain)"}`);
  }
  return out;
}
