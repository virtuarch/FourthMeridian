/**
 * lib/platform/intelligence/ai/conversations/multi-area.ts  (Platform AI P4b — multi-area conversations, PURE)
 *
 * Design v2 §8.3. Before P4b a conversation turn bound ONLY the area the conversation was
 * created under (S2 #483 B1 option (b)); the stateless ask route already bound every held area.
 * P4b: a conversation TURN binds the areas the operator holds NOW —
 *
 *   · the conversation's OWN area is still the gate (handlers.ts step 6: its fresh,
 *     non-probe guard; refused ⇒ the ONE 404, exactly as before);
 *   · every OTHER area in the operator's directory is added only through ITS OWN fresh guard
 *     (the route's `accessFor`, area-access.ts conversationHeldAccess: requireFreshPlatformAccess
 *     probe, scopeFromGuard, bindArea — tokens minted from that guard). A refused area is left
 *     out; nothing here grants anything;
 *   · the turn boundary then rechecks every area per tool call, as for the ask route (§6.2);
 *   · an operator who holds ONE area gets their access back unchanged (the same binding object,
 *     the same single scope — the pre-P4b turn), plus `heldAreas = {own}`.
 *
 * LOST AREAS (an area read by an earlier turn that the operator no longer holds): the stored
 * answer's provenance (`{k:"a"}` evidence refs — areasRead, plus a record span's own area) decides.
 * An answer that read ANY area not held now is not shown (view / replay ⇒ "[no longer available]",
 * no figure, citation or note) and not replayed to the model (history ⇒ the same marker), and its
 * record spans are never rendered (no recheck, no audit, no T2). Fail closed: a whole answer, not
 * a guess per segment. Answers that only read held areas are unchanged. A pre-P4b answer only ever
 * read its conversation's own area, which is held whenever the conversation is reachable at all.
 *
 * Nothing here imports a database, env, a guard or the provider.
 */

import type { PlatformArea } from "@prisma/client";
import { ALL_PLATFORM_AREAS } from "@/lib/platform/policy";
import { composePlatformAiBindings, type PlatformAiBinding } from "../core";
import type { ScopedArea } from "../authz/boundary";
import { EVIDENCE_REFS_MAX, type EvidenceRef, type StoredAnswer } from "./answer";
import type { AreaAccess } from "./handlers";

/** One area of a turn: the route-issued scope and the binding built from the same fresh guard. */
export interface TurnAreaPart { readonly scope: ScopedArea; readonly binding: PlatformAiBinding }

/**
 * Widen the conversation's OWN access (already fresh-guarded) to every other area in `others`
 * that passes ITS OWN fresh guard (`accessFor`). Never throws (a throwing `accessFor` ⇒ that area
 * is left out). One area ⇒ `own` unchanged except `heldAreas`.
 */
export async function widenConversationAccess(
  own: AreaAccess, others: readonly PlatformArea[], accessFor: (area: PlatformArea) => Promise<AreaAccess | null>,
): Promise<AreaAccess> {
  if (!own.area || !own.scope) return own;
  const parts: TurnAreaPart[] = [{ scope: own.scope, binding: own.binding }];
  for (const a of others) {
    if (parts.some((p) => p.scope.area === a)) continue;
    let acc: AreaAccess | null = null;
    try { acc = await accessFor(a); } catch { acc = null; }
    // The other area's OWN guard result only: its scope, for exactly this area and this operator.
    if (!acc?.scope || acc.area !== a || acc.scope.area !== a || acc.scope.operatorId !== own.scope.operatorId) continue;
    parts.push({ scope: acc.scope, binding: acc.binding });
  }
  const heldAreas: ReadonlySet<PlatformArea> = new Set(parts.map((p) => p.scope.area));
  if (parts.length === 1) return { ...own, heldAreas };
  const binding = composePlatformAiBindings(parts.map((p) => ({ area: p.scope.area, binding: p.binding })));
  if (!binding) return { ...own, heldAreas: new Set([own.area]) };
  return {
    ...own,
    binding,
    // Stored links re-resolve through every held area's token (a lost area's page ⇒ plain text, as before).
    resolvePage: (page, params) => binding.resolvePage(page, params),
    turnAreas: parts,
    heldAreas,
  };
}

/** The areas a stored answer read: its `{k:"a"}` provenance and every record span's own area. */
export function answerAreas(refs: readonly EvidenceRef[], answer: StoredAnswer | null): string[] {
  const out = new Set<string>(refs.filter((r): r is Extract<EvidenceRef, { k: "a" }> => r.k === "a").map((r) => r.id));
  for (const s of answer?.segments ?? []) if (s.kind === "record") out.add(s.a);
  return [...out];
}

/**
 * May this stored answer be shown / replayed to a viewer who holds `held` now? Every area it read
 * must be held. No `held` (an access without P4b widening) ⇒ true (the pre-P4b behaviour).
 */
export function answerReadable(refs: readonly EvidenceRef[], answer: StoredAnswer | null, held: ReadonlySet<PlatformArea> | undefined): boolean {
  if (!held) return true;
  return answerAreas(refs, answer).every((a) => held.has(a as PlatformArea));
}

/**
 * The turn's provenance, completed (multi-area turns only): the areas whose PACK tools (not the
 * core metric / navigation / memory tools, whose metric reads areasRead already records by
 * envelope surface) ran this turn are added as `{k:"a"}` refs, so a later loss of any of them
 * hides this answer. The area refs are kept whole; other refs give way under EVIDENCE_REFS_MAX.
 */
export function withAreasRead(refs: readonly EvidenceRef[], extra: readonly PlatformArea[]): EvidenceRef[] {
  const have = new Set(refs.filter((r) => r.k === "a").map((r) => (r as { id: string }).id));
  if (extra.every((a) => have.has(a))) return [...refs];
  for (const a of extra) have.add(a);
  const areas = ALL_PLATFORM_AREAS.filter((a) => have.has(a)).map((a): EvidenceRef => ({ k: "a", id: a }));
  const rest = refs.filter((r) => r.k !== "a");
  return [...rest.slice(0, Math.max(0, EVIDENCE_REFS_MAX - areas.length)), ...areas];
}

/**
 * The areas a turn's PACK tools ran over (the boundary's toolAreas()), the core packs excluded
 * (`corePacks` = engine/router.ts CORE_PACKS, injected so this module stays free of env reads).
 */
export function packAreasRead(ran: ReadonlyMap<string, readonly PlatformArea[]>, corePacks: readonly string[]): PlatformArea[] {
  return [...ran].filter(([p]) => !corePacks.includes(p)).flatMap(([, areas]) => areas);
}
