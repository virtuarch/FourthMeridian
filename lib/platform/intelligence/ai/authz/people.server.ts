/**
 * lib/platform/intelligence/ai/authz/people.server.ts  (Platform AI — the @ people picker + guard's Production effects)
 *
 * Wires authz/people.ts to:
 *   authority    platformAiP5Authority — the customers pack flag ON (strict, default OFF) AND a FRESH
 *                requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ") that is in scope (the authz/scope.ts
 *                inScope: a real grant for exactly that area, this operator, never break-glass — I-7) AND the
 *                CS incident tier minted from THAT guard result (incidentAudienceFor — the guard-provenance
 *                pin). The SAME authority authz/subject.ts resolves customers with (boundary.subjectEligibility).
 *   limit        S2 09fl ruling 3 — the PICKER's own bucket: checkKeyLimitStrict(operatorId, PEOPLE_LIMITER_NAME,
 *                PEOPLE_LIMIT) (30 / h, keyed on the guard's user id);
 *   consume /    the GUARD stays on the P5 subject bucket: checkKeyLimitStrict(operatorId, SUBJECT_LIMITER_NAME,
 *   exhausted    SUBJECT_LIMIT) (20 / h, shared with subject lookups incl. chips); `exhausted` reads it without counting (peekKey);
 *   search       authz/people-readers.server.ts searchCustomersByPrefix (CUSTOMER_WHERE, statement timeout);
 *   usernameHit  authz/people-readers.server.ts customerUsernameHit (one exact indexed query);
 *   refOf        the PRIV-ref token (opaqueUserRef — no new key material);
 *   fingerprint  opaquePurposeFingerprint(PEOPLE_FINGERPRINT_LABEL, q) — keyed, its own purpose label;
 *   audit        authz/audit.ts platformAiPeopleSearchAudit / platformAiPeopleGuardAudit (codes + counts only);
 *   exempt       authz/people-vocabulary.ts isProductVocabulary (built from the registries);
 *   clock        the real clock (floor 300 ms, abort 1,500 ms).
 * Never logs.
 */

import "server-only";

import { UserRole, type PlatformArea } from "@prisma/client";
import { requireFreshPlatformAccess, type PlatformAuth } from "@/lib/platform/authorize";
import { incidentAudienceFor } from "@/lib/platform/incidents/intelligence/audience";
import { checkKeyLimitStrict, peekKey } from "@/lib/rate-limit";
import { opaquePurposeFingerprint, opaqueUserRef } from "@/lib/platform/opaque-user-ref";
import { opaqueRefToken } from "@/lib/platform/opaque-user-ref-format";
import { platformAiPackEnabled } from "../engine/router";
import { customerUsernameHit, searchCustomersByPrefix } from "./people-readers.server";
import { platformAiPeopleGuardAudit, platformAiPeopleSearchAudit } from "./audit";
import { PEOPLE_FINGERPRINT_LABEL, PEOPLE_LIMIT, PEOPLE_LIMITER_NAME, PEOPLE_RESULTS_MAX, runPickerGuard, type PeopleSearchDeps, type PickerGuardDeps, type PickerGuardVerdict } from "./people";
import { isProductVocabulary } from "./people-vocabulary";
import { REAL_SUBJECT_CLOCK, SUBJECT_LIMIT, SUBJECT_LIMITER_NAME, type SubjectLimiterVerdict } from "./subject";

const P5_AREA: PlatformArea = "CUSTOMER_SUCCESS";

/**
 * The I-7 scope rule for the CS area (the same predicate as authz/scope.ts inScope, which is import-pinned to
 * its four callers): a REAL grant for exactly CUSTOMER_SUCCESS, issued to this operator, not a SYSTEM_ADMIN —
 * break-glass (grant null) never earns subject-lookup authority.
 */
function isOwnCsGrant(fresh: PlatformAuth, operatorId: string): boolean {
  return fresh.grant !== null && fresh.grant.area === P5_AREA && typeof operatorId === "string" && operatorId.length > 0
    && fresh.user?.id === operatorId && fresh.user.role !== UserRole.SYSTEM_ADMIN;
}

/**
 * P5 subject-lookup authority NOW, from a FRESH guard (session row, grant row, operator 2FA): the customers pack
 * flag ON, the I-7 rule for the CS area, and the CS incident tier minted from THAT guard result. A probe: a refusal
 * is not recorded as OBS-009 (the guard asks on every turn of operators who never requested CS; the picker route
 * has already run the recorded CS guard itself).
 */
export async function platformAiP5Authority(operatorId: string): Promise<boolean> {
  if (!platformAiPackEnabled("customers")) return false;
  const [fresh, freshErr] = await requireFreshPlatformAccess(P5_AREA, "READ", { probe: true });
  if (freshErr || !fresh || !isOwnCsGrant(fresh, operatorId)) return false;
  return incidentAudienceFor(fresh)?.audience === "CUSTOMER_SUCCESS";
}

const verdictOf = (v: Awaited<ReturnType<typeof checkKeyLimitStrict>>): SubjectLimiterVerdict =>
  (v.status === "ok" ? "ok" : v.status === "limited" ? "limited" : "unavailable");
/** The P5 subject bucket (20 / h): guard hits; shared with subject lookups and chip resolution. */
const subjectLimit = async (operatorId: string) => verdictOf(await checkKeyLimitStrict(operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT));
/** The picker's OWN bucket (30 / h, S2 09fl ruling 3). */
const pickerLimit = async (operatorId: string) => verdictOf(await checkKeyLimitStrict(operatorId, PEOPLE_LIMITER_NAME, PEOPLE_LIMIT));

/** The picker search's Production effects (the route has already checked P5 authority). */
export function platformAiPeopleSearchDeps(operatorId: string): PeopleSearchDeps {
  return {
    operatorId,
    limit: () => pickerLimit(operatorId),
    search: (q) => searchCustomersByPrefix(q, PEOPLE_RESULTS_MAX),
    refOf: (userId) => opaqueRefToken(opaqueUserRef(userId)),
    fingerprint: (q) => opaquePurposeFingerprint(PEOPLE_FINGERPRINT_LABEL, q),
    audit: platformAiPeopleSearchAudit(),
    clock: REAL_SUBJECT_CLOCK,
  };
}

/** The guard's Production effects for one operator (the audit actor falls back to the turn's area). */
export function platformAiPickerGuardDeps(input: { operatorId: string; primaryArea: PlatformArea }): PickerGuardDeps {
  return {
    operatorId: input.operatorId,
    authority: () => platformAiP5Authority(input.operatorId),
    exempt: isProductVocabulary,
    exhausted: async () => (await peekKey(input.operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT.windowSec)) >= SUBJECT_LIMIT.limit,
    consume: () => subjectLimit(input.operatorId),
    usernameHit: (tokens) => customerUsernameHit(tokens),
    audit: platformAiPeopleGuardAudit(input.primaryArea),
    clock: REAL_SUBJECT_CLOCK,
  };
}

/** The guard for the ask route and the conversation turn handlers. */
export const platformAiPickerGuard = (input: { operatorId: string; primaryArea: PlatformArea }) =>
  (raw: string): Promise<PickerGuardVerdict> => runPickerGuard(raw, platformAiPickerGuardDeps(input));
