/**
 * lib/platform/intelligence/ai/authz/recheck.ts  (Platform AI P2 — the per-call recheck, I-6 / D-6)
 *
 * A turn's scope is decided once by the route (authz/scope.ts), then RE-DECIDED on every
 * tool call: `recheck(area)` is injected by the caller as
 *   requireFreshPlatformAccess(area, "READ")   (NON-probe — authz/recheck.server.ts)
 * i.e. AUTHORITATIVE DB reads on every call: the live session row (revocation,
 * lib/session.ts requireFreshUser), the grant row (status ACTIVE, level) and the
 * holder's 2FA state when enforced. Nothing is memoised across calls — N tool calls make
 * N rechecks per area (recheck.test.ts counts the grant reads).
 *
 * The fresh result must pass the SAME I-7 rule as the route's (scope.ts inScope: a real
 * grant for exactly that area, this operator, not a SYSTEM_ADMIN). A refusal — a revoked
 * grant / session, 2FA dropped, a different session user, break-glass, a thrown read —
 * makes THAT call NOT_FOUND and REMOVES the area from the turn's scope for the rest of
 * the turn (no further rechecks for it); the turn continues on the remaining areas.
 * A mid-turn revocation is a real denial: the non-probe guard records it (OBS-009).
 *
 * Also returned: whether the fresh guard carries the CUSTOMER_SUCCESS incident audience
 * (the tier step of the boundary; computed by the injected recheck from its own guard).
 *
 * Denial log rows (S2 ruling 2, 2026-11-09): codes only — tool, pack, reason enum —
 * never arguments or handles; one row per identical denial per turn (createDenialLog).
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { inScope, isScopedArea, type ScopeAuth, type ScopedArea } from "./scope";

/** One fresh guard result for one area (from the injected recheck). */
export interface FreshGuard {
  readonly auth: ScopeAuth;
  /** incidentAudienceFor(fresh auth).audience === "CUSTOMER_SUCCESS", decided by the guarded caller. */
  readonly csTier: boolean;
}

/** Injected from the route: requireFreshPlatformAccess(area, "READ"); null on any refusal. */
export type PlatformAiRecheck = (area: PlatformArea) => Promise<FreshGuard | null>;

export interface TurnScope {
  /** The areas still in scope, registry order of the route's scopes. */
  areas(): PlatformArea[];
  has(area: PlatformArea): boolean;
  /** True once any area has been removed this turn. */
  narrowed(): boolean;
  /**
   * A FRESH recheck of `area` (one injected call ⇒ authoritative DB reads). null ⇒ refused:
   * the area leaves the scope for the rest of the turn. An area not in scope is null
   * without a read.
   */
  recheck(area: PlatformArea): Promise<FreshGuard | null>;
}

/** The turn's live scope over the route-issued ScopedAreas (forged / foreign scopes are dropped). */
export function createTurnScope(input: { operatorId: string; scopes: readonly ScopedArea[]; recheck: PlatformAiRecheck }): TurnScope {
  const live: PlatformArea[] = [];
  for (const s of input.scopes) {
    if (isScopedArea(s) && s.operatorId === input.operatorId && !live.includes(s.area)) live.push(s.area);
  }
  const initial = live.length;
  const remove = (area: PlatformArea) => { const i = live.indexOf(area); if (i >= 0) live.splice(i, 1); };
  return {
    areas: () => [...live],
    has: (area) => live.includes(area),
    narrowed: () => live.length < initial,
    async recheck(area) {
      if (!live.includes(area)) return null;
      let fresh: FreshGuard | null;
      try { fresh = await input.recheck(area); } catch { fresh = null; }
      if (!fresh || !inScope(fresh.auth, area, input.operatorId)) { remove(area); return null; }
      return { auth: fresh.auth, csTier: fresh.csTier === true };
    },
  };
}

// ── Denial log rows (S2 ruling 2) ─────────────────────────────────────────────

/** Why the boundary refused a call — a closed enum (the only "reason" a row carries). */
export const BOUNDARY_DENIAL_REASONS = [
  "UNKNOWN_TOOL", "PACK_NOT_ROUTED", "PACK_DISABLED", "ARGS_INVALID", "AREA_NOT_IN_SCOPE",
  "RECHECK_REFUSED", "HANDLE_UNRESOLVED", "TIER_REFUSED", "REVALIDATE_REFUSED",
] as const;
export type BoundaryDenialReason = (typeof BOUNDARY_DENIAL_REASONS)[number];

/** One denial row: codes only. `tool` is a REGISTERED tool name or "unknown" (never model text). */
export interface DenialRow { readonly tool: string; readonly pack: string; readonly reason: BoundaryDenialReason }

/** Per-turn dedupe: `emit` forwards a row the first time (tool, pack, reason) is seen this turn. */
export function createDenialLog(sink: ((row: DenialRow) => void) | undefined): { emit(row: DenialRow): void; readonly rows: number } {
  const seen = new Set<string>();
  return {
    emit(row) {
      const k = `${row.tool}|${row.pack}|${row.reason}`;
      if (seen.has(k)) return;
      seen.add(k);
      try { sink?.({ tool: row.tool, pack: row.pack, reason: row.reason }); } catch { /* a log sink never changes the answer */ }
    },
    get rows() { return seen.size; },
  };
}
