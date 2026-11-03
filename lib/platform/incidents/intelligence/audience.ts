/**
 * lib/platform/incidents/intelligence/audience.ts  (PB-1 Phase 2 — the ONLY audience minter)
 *
 * An incident accessor never takes an audience STRING: a string is forgeable,
 * and `brokenNow("CUSTOMER_SUCCESS")` would hand any caller the customer id.
 * It takes an AudienceToken, which exists only if this module minted it:
 *
 *   - the TYPE is branded with a `unique symbol` no other module can name, so a
 *     hand-built `{ audience: "CUSTOMER_SUCCESS" }` does not type-check;
 *   - at RUNTIME every minted token is registered in a module-private WeakSet,
 *     so an `as never` cast or a JS caller is refused by `assertAudienceToken`.
 *
 * MINTING
 *   incidentAudienceFor(auth)   from the route's existing guard result
 *                               (requirePlatformAccess / requireFreshPlatformAccess):
 *     CUSTOMER_SUCCESS grant (any level ≥ READ)  → CUSTOMER_SUCCESS token
 *     PLATFORM_OPS grant (any level ≥ READ)      → PLATFORM_OPS token
 *     SYSTEM_ADMIN break-glass (grant: null)     → CUSTOMER_SUCCESS token
 *       Lead decision 2026-11-03: a System Admin already holds CS READ through
 *       break-glass (lib/platform/authorize.ts), so the incident tier follows it.
 *     anything else                               → null (no incident read)
 *   systemIncidentAudience()    the SYSTEM token, for the alert engine ONLY.
 *       Statically pinned: only lib/alerts/ may import it
 *       (intelligence/audience.test.ts, like db-authority pins systemDb).
 *
 * GUARD PROVENANCE (static pin, audience.test.ts): `incidentAudienceFor(x)` is
 * accepted ONLY where `x` is the value destructured from
 * `await requirePlatformAccess(…)` / `await requireFreshPlatformAccess(…)` in the
 * same function, and this module is imported nowhere else except those routes,
 * the accessors (./index.ts) and lib/alerts/ (SYSTEM). A hand-built
 * `{ user: { role: "SYSTEM_ADMIN" }, grant: null }` therefore cannot reach it.
 *
 * ⚠️ ONE MODULE INSTANCE. The WeakSet is module-instance state: if the bundler
 * ever split this file into two chunks, a token minted in one would not be
 * recognised in the other (it FAILS CLOSED — a refused read, never a leak).
 * Mint and use a token within the same request, in the same route module; never
 * cache, serialise or pass one across a module/worker boundary.
 *
 * The pure core keeps a plain string audience (it is pure and has no caller
 * outside this module's accessors); the pin is that only the accessors and
 * this minter ever pass "CUSTOMER_SUCCESS" to it.
 */

import { UserRole } from "@prisma/client";
import type { PlatformAuth } from "@/lib/platform/authorize";
import type { IncidentAudience } from "./types";

declare const AUDIENCE_BRAND: unique symbol;

/** Unforgeable: only this module can produce a value of this type. */
export interface AudienceToken<A extends IncidentAudience = IncidentAudience> {
  readonly __brand: typeof AUDIENCE_BRAND;
  readonly audience: A;
}

export type CsToken = AudienceToken<"CUSTOMER_SUCCESS">;
export type OpsToken = AudienceToken<"PLATFORM_OPS">;
export type SystemToken = AudienceToken<"SYSTEM">;

const MINTED = new WeakSet<object>();

function mint<A extends IncidentAudience>(audience: A): AudienceToken<A> {
  const token = Object.freeze({ audience }) as unknown as AudienceToken<A>;
  MINTED.add(token);
  return token;
}

/** Only the parts of a guard result the tier depends on. */
export type AudienceAuth = { user: Pick<PlatformAuth["user"], "role">; grant: PlatformAuth["grant"] };

/** The tier the route's EXISTING guard result entitles — never more. */
/** Grant levels that may read incidents (every PlatformAccessLevel is ≥ READ; an unknown one mints nothing). */
export const INCIDENT_READ_LEVELS: readonly string[] = ["READ", "WRITE", "CONTROL"];

export function incidentAudienceFor(auth: AudienceAuth): CsToken | OpsToken | null {
  if (auth.grant === null) {
    // Break-glass: authorize.ts returns grant:null ONLY for an allowed SYSTEM_ADMIN.
    return auth.user.role === UserRole.SYSTEM_ADMIN ? mint("CUSTOMER_SUCCESS") : null;
  }
  if (!INCIDENT_READ_LEVELS.includes(String(auth.grant.level))) return null;
  if (auth.grant.area === "CUSTOMER_SUCCESS") return mint("CUSTOMER_SUCCESS");
  if (auth.grant.area === "PLATFORM_OPS") return mint("PLATFORM_OPS");
  return null;
}

/** The alert engine's token. lib/alerts/ only (statically pinned). */
export function systemIncidentAudience(): SystemToken {
  return mint("SYSTEM");
}

export class IncidentAudienceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncidentAudienceError";
  }
}

/**
 * The runtime gate every accessor calls first. Refuses a token this module did
 * not mint, and one whose audience is not in `allowed`.
 */
export function assertAudienceToken<A extends IncidentAudience>(token: unknown, allowed: readonly A[]): A {
  if (typeof token !== "object" || token === null || !MINTED.has(token)) {
    throw new IncidentAudienceError("incident read refused: not an audience token minted by incidentAudienceFor / systemIncidentAudience");
  }
  const audience = (token as { audience: IncidentAudience }).audience;
  if (!(allowed as readonly IncidentAudience[]).includes(audience)) {
    throw new IncidentAudienceError(`incident read refused: a ${audience} token cannot read this (needs ${allowed.join(" | ")})`);
  }
  return audience as A;
}
