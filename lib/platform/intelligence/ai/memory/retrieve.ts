/**
 * lib/platform/intelligence/ai/memory/retrieve.ts  (Platform AI operational memory — read + the B3 rule)
 *
 * Design v2 §2 "Retrieve rule (B3)", D8, D9. Every surface that SHOWS memory
 * (the turn injection, recall, the panel) reads through `retrieveFacts`:
 *
 *   1. the store's visibleFacts (owner, held area via RLS, not deleted / expired /
 *      invalidated), at most `take`;
 *   2. revalidateFacts under ONE 2 s budget, through the readers the caller built
 *      from its FRESH guard on each fact's area (a revoked area has no readers ⇒
 *      its facts are not shown at all; RLS already hides them);
 *   3. the B3 rule, by fact type:
 *
 *        result     | OPERATIONAL_STATE                       | WATCHING_ISSUE / FOLLOW_UP
 *        GONE       | invalidate GONE; hidden                 | invalidate GONE; hidden
 *        CHANGED    | shown ONCE as CHANGED{was,now}, then    | always shown CHANGED against the
 *                   | invalidated STATE_CHANGED (same pass)   | state at creation; never invalidated
 *        UPDATED    | UPDATED badge                           | UPDATED badge
 *        UNCHANGED / UNVERIFIED shown as such
 *
 *      "Once" = the first surface that observes it. The panel (mode "panel")
 *      shows a GONE row ONCE, type only (no label, no link), as it invalidates it.
 *   4. invalidations go through the store (one aggregated audit row per area +
 *      reason). Memory reads NEVER extend expiresAt (the schema forbids it).
 */

import type { PlatformArea } from "@prisma/client";
import { MEMORY_FACTS_INJECTED_MAX } from "./constants";
import { revalidateFacts, type FactCheck, type MemoryReaders } from "./revalidate";
import type { MemoryFactRecord } from "./store";

export type ShownStatus = "UNCHANGED" | "CHANGED" | "UPDATED" | "UNVERIFIED" | "GONE";

export interface RetrievedFact {
  fact: MemoryFactRecord;
  check: FactCheck;
  /** What this surface shows. GONE only in mode "panel" (type only). */
  shown: ShownStatus;
}

/** The store seam (memory/store.ts in production; a fake in unit tests). */
export interface RetrieveStore {
  visibleFacts(operatorId: string, opts: { areas?: readonly PlatformArea[]; ids?: readonly string[]; take?: number }): Promise<MemoryFactRecord[]>;
  invalidateFacts(operatorId: string, items: ReadonlyArray<{ id: string; area: PlatformArea; reason: "GONE" | "STATE_CHANGED" | "AREA_LOST" }>): Promise<number>;
}

export interface RetrieveInput {
  operatorId: string;
  /** The areas this surface reads (the turn: its one area; the panel: every held area). */
  areas: readonly PlatformArea[];
  /** The authorized readers for an area, from a FRESH guard; null ⇒ not readable now (nothing shown for it). */
  readersFor(area: PlatformArea): Promise<MemoryReaders | null>;
  store: RetrieveStore;
  mode: "inject" | "panel";
  take?: number;
  budgetMs?: number;
}

/** PURE — the B3 decision for one fact: what to show, and the invalidation it causes. */
export function applyRetrieveRule(fact: Pick<MemoryFactRecord, "factType">, check: FactCheck, mode: "inject" | "panel"):
  { shown: ShownStatus | null; invalidate: "GONE" | "STATE_CHANGED" | null } {
  switch (check.status) {
    case "GONE": return { shown: mode === "panel" ? "GONE" : null, invalidate: "GONE" };
    case "CHANGED": return { shown: "CHANGED", invalidate: fact.factType === "OPERATIONAL_STATE" ? "STATE_CHANGED" : null };
    case "UPDATED": return { shown: "UPDATED", invalidate: null };
    case "UNVERIFIED": return { shown: "UNVERIFIED", invalidate: null };
    case "UNCHANGED": return { shown: "UNCHANGED", invalidate: null };
  }
}

export async function retrieveFacts(input: RetrieveInput): Promise<{ facts: RetrievedFact[]; invalidated: number }> {
  if (input.areas.length === 0) return { facts: [], invalidated: 0 };
  const take = input.take ?? (input.mode === "inject" ? MEMORY_FACTS_INJECTED_MAX : undefined);
  const facts = await input.store.visibleFacts(input.operatorId, { areas: input.areas, ...(take ? { take } : {}) });
  const byArea = new Map<PlatformArea, MemoryFactRecord[]>();
  for (const f of facts) byArea.set(f.area, [...(byArea.get(f.area) ?? []), f]);
  const out: RetrievedFact[] = [];
  const invalidate: Array<{ id: string; area: PlatformArea; reason: "GONE" | "STATE_CHANGED" }> = [];
  for (const [area, list] of byArea) {
    let readers: MemoryReaders | null = null;
    try { readers = await input.readersFor(area); } catch { readers = null; }
    if (!readers) continue;   // not readable now (refused): shown nowhere, never invalidated here
    const checks = await revalidateFacts(list, readers, input.budgetMs);
    for (const f of list) {
      const check = checks.get(f.id);
      if (!check) continue;
      const r = applyRetrieveRule(f, check, input.mode);
      if (r.invalidate) invalidate.push({ id: f.id, area, reason: r.invalidate });
      if (r.shown) out.push({ fact: f, check, shown: r.shown });
    }
  }
  let invalidated = 0;
  if (invalidate.length > 0) {
    try { invalidated = await input.store.invalidateFacts(input.operatorId, invalidate); } catch { invalidated = 0; }
  }
  return { facts: out, invalidated };
}

// ── Server-rendered text (never model text, never a stored label) ────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "8 Nov 2026" (UTC) — the only date memory ever renders. */
export const notedDate = (d: Date): string => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

/** The {{mem:<id>}} text (D10 tails): "noted 8 Nov 2026", "… — now changed", "… — updated since". */
export function memPlaceholderText(r: Pick<RetrievedFact, "shown"> & { fact: Pick<MemoryFactRecord, "observedAt"> }): string {
  const base = `noted ${notedDate(r.fact.observedAt)}`;
  if (r.shown === "CHANGED") return `${base} — now changed`;
  if (r.shown === "UPDATED") return `${base} — updated since`;
  return base;
}

/** The stored memory span shape (conversations/answer.ts): exactly the text memPlaceholderText can produce. */
export { MEMORY_SPAN_SHAPE } from "../conversations/answer";

/** A note as context for the model: braces neutralised, digits masked, quotes flattened (design §4). */
export const neutraliseNote = (note: string): string => note.replace(/[{}]/g, "").replace(/\d/g, "#").replace(/"/g, "'");

/** The live check phrase for a shown fact. */
export function liveCheckPhrase(r: RetrievedFact): string {
  switch (r.shown) {
    case "CHANGED": return `CHANGED (was ${r.check.was ?? "UNKNOWN"}, now ${r.check.now ?? "UNKNOWN"})`;
    case "UPDATED": return "UPDATED (same state, record edited since)";
    case "UNVERIFIED": return "UNVERIFIED (could not re-check now; never treat as current)";
    case "GONE": return "GONE";
    default: return "UNCHANGED";
  }
}
