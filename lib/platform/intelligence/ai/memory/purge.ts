/**
 * lib/platform/intelligence/ai/memory/purge.ts  (Platform AI operational memory — the retention rule)
 *
 * Design v2 §1 "fm_purge_platform_ai_memory", §6, §10. The retention job runs as
 * fm_system, which holds NO grant on PlatformAiMemoryFact. It reaches the table
 * only through `fm_purge_platform_ai_memory(p_limit)` — SECURITY DEFINER, fixed
 * predicates (expired; soft-deleted; invalidated > 1 day; no ACTIVE grant for
 * the row's operator + area), counts in and counts out. fm_system never sees an
 * id, a timestamp, a note or a ref.
 *
 * ⚠️ SHIPS DISABLED. `PLATFORM_AI_MEMORY_PURGE_ENABLED` defaults OFF; while off
 * this rule makes NO database contact. It is independent of the memory flag, so
 * the purge keeps running after memory is switched off (disable order: memory
 * off, purge, THEN the purge flag). Memory set while its purge is off is
 * reported as `misordered` (the job fails its JobRun — jobs/purge-trash.ts).
 *
 * Pure orchestration over injected seams (as conversations/purge.ts); the real
 * seams are wired in jobs/data-retention.ts against systemDb.
 */

import { AuditAction } from "@/lib/audit-actions";
import { MEMORY_PURGE_BATCH, MEMORY_PURGE_MAX_CALLS } from "./constants";

export interface PlatformAiMemoryPurgeResult {
  /** False ⇒ the flag is off and nothing was contacted. */
  enabled: boolean;
  facts: number;
  batches: number;
  /** True when the last call did not saturate the batch (nothing more to remove right now). */
  exhausted: boolean;
  error?: string;
  /** The memory flag is set while the memory purge flag is not (nothing contacted). */
  misordered?: true;
}

export interface PlatformAiMemoryPurgeDeps {
  enabled: boolean;
  /** One call of the definer function: `SELECT fm_purge_platform_ai_memory($limit)`. */
  call(limit: number): Promise<number>;
  /** One AuditLog row (fm_system INSERT): counts only; `failed: true` when the run errored part-way. */
  audit(detail: { facts: number; batches: number; exhausted: boolean; failed?: true }): Promise<void>;
  /** Write the counts-only audit row even when nothing was purged (the manual dispatch). */
  auditEveryRun?: boolean;
  /** env.isPlatformAiMemoryFlagSetWithoutPurge — only meaningful while `enabled` is false. */
  misordered?: boolean;
}

/** The SQL the real seam runs — the ONLY statement fm_system issues against memory (besides the per-operator purge). */
export const PLATFORM_AI_MEMORY_PURGE_SQL = `SELECT public.fm_purge_platform_ai_memory($1::integer) AS facts`;
/** The per-operator purge (System Admin purge-operator, offboarding) — fm_system only. */
export const PLATFORM_AI_MEMORY_PURGE_OPERATOR_SQL = `SELECT public.fm_purge_platform_ai_memory_for_operator($1::text) AS facts`;

export const PLATFORM_AI_MEMORY_PURGE_AUDIT_ACTION = AuditAction.PLATFORM_AI_MEMORY_PURGED;

/** Normalise the function's one returned row (a count only; anything else is refused). */
export function parseMemoryPurgeRow(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new Error("memory purge function returned an unexpected shape");
  const r = rows[0] as Record<string, unknown>;
  if (Object.keys(r).join() !== "facts") throw new Error("memory purge function returned an unexpected shape");
  const v = r.facts;
  const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error("memory purge function returned a non-count");
  return n;
}

export async function runPlatformAiMemoryPurge(deps: PlatformAiMemoryPurgeDeps): Promise<PlatformAiMemoryPurgeResult> {
  const out: PlatformAiMemoryPurgeResult = { enabled: deps.enabled, facts: 0, batches: 0, exhausted: false };
  if (!deps.enabled) {
    if (deps.misordered) {
      out.misordered = true;
      console.error("[data-retention] platform-ai-memory purge is DISABLED while PLATFORM_AI_MEMORY_ENABLED is set — disable order: memory off first, purge, then the purge flag");
    }
    return out;
  }
  try {
    while (out.batches < MEMORY_PURGE_MAX_CALLS) {
      const n = await deps.call(MEMORY_PURGE_BATCH);
      out.batches++;
      out.facts += n;
      if (n < MEMORY_PURGE_BATCH) { out.exhausted = true; break; }
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    console.error("[data-retention] platform-ai-memory purge failed (others continue)");
  }
  if (out.facts > 0 || deps.auditEveryRun) {
    try {
      await deps.audit({ facts: out.facts, batches: out.batches, exhausted: out.exhausted, ...(out.error !== undefined ? { failed: true as const } : {}) });
    } catch {
      console.error("[data-retention] platform-ai-memory purge audit row failed");
    }
    console.log(`[data-retention] platform-ai-memory: purged ${out.facts} fact(s)${out.exhausted ? "" : " (more remain)"}`);
  }
  return out;
}

/** A failed or misordered memory purge fails the purge-trash JobRun (a fixed code, never error text). Null ⇒ healthy. */
export function platformAiMemoryPurgeJobFailure(r: PlatformAiMemoryPurgeResult | undefined): string | null {
  if (!r) return null;
  if (r.misordered) return "platform-ai-memory purge MISORDERED: the memory purge flag is off while the memory flag is set; the other retention rules completed";
  if (r.error !== undefined) return "platform-ai-memory purge FAILED (the result carries the error); the other retention rules completed";
  return null;
}
