/**
 * lib/platform/intelligence/ai/authz/subject.server.ts  (Platform AI P5 — subject resolution's Production effects)
 *
 * Wires authz/subject.ts to:
 *   limit        checkKeyLimitStrict(operatorId, "platform-ai-subject", { limit: 20, windowSec: 3600 })
 *                (lib/rate-limit.ts — fail closed: `unavailable` ⇒ UNAVAILABLE);
 *   enabled      the customers pack flag (engine/router.ts platformAiPackEnabled — strict, default OFF);
 *   eligibility  the turn boundary's fresh per-call recheck (CS area first);
 *   lookup       exact reads within the customer population (tools/packs/customers.server.ts);
 *   audit        authz/audit.ts platformAiSubjectAudit (PLATFORM_AI_SUBJECT_LOOKUP, every outcome);
 *   mint         the boundary's adoptSubject (re-check + re-validate; a handle of THIS turn);
 *   keyHash      opaqueDedupeToken — the PRIV-ref key and purpose (S2 ruling 5: no new key material);
 *   clock        the real clock (floor 300 ms, abort 1,500 ms).
 * Created per turn by the caller that holds the boundary (the ask route, the conversations' turn runner).
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { checkKeyLimitStrict } from "@/lib/rate-limit";
import { opaqueDedupeToken } from "@/lib/platform/opaque-user-ref";
import { platformAiPackEnabled } from "../engine/router";
import { CUSTOMER_AREA, CUSTOMER_RECORD_KIND } from "../tools/packs/customers";
import { customerRid, findCustomerByEmail, findCustomerById, findCustomerByRefToken } from "../tools/packs/customers.server";
import { platformAiSubjectAudit } from "./audit";
import type { TurnBoundary } from "./boundary";
import { REAL_SUBJECT_CLOCK, SUBJECT_LIMIT, SUBJECT_LIMITER_NAME, type SubjectDeps, type SubjectIdentifier } from "./subject";

/** The Production lookup for one exact identifier (customer population only). */
export async function lookupCustomerSubject(id: SubjectIdentifier): Promise<string | null> {
  switch (id.kind) {
    case "EMAIL": return findCustomerByEmail(id.normalized);
    case "USER_ID": return findCustomerById(id.normalized);
    case "OPAQUE_REF": return findCustomerByRefToken(id.normalized.slice("user #".length));
  }
}

export function platformAiSubjectDeps(input: { operatorId: string; primaryArea: PlatformArea; boundary: Pick<TurnBoundary, "subjectEligibility" | "adoptSubject"> }): SubjectDeps {
  return {
    operatorId: input.operatorId,
    primaryArea: input.primaryArea,
    enabled: () => platformAiPackEnabled("customers"),
    limit: async () => {
      const v = await checkKeyLimitStrict(input.operatorId, SUBJECT_LIMITER_NAME, SUBJECT_LIMIT);
      return v.status === "ok" ? "ok" : v.status === "limited" ? "limited" : "unavailable";
    },
    eligibility: () => input.boundary.subjectEligibility(),
    lookup: lookupCustomerSubject,
    audit: platformAiSubjectAudit(),
    mint: async (userId) => {
      const rid = customerRid(userId);
      return rid ? input.boundary.adoptSubject({ rk: CUSTOMER_RECORD_KIND, rid, area: CUSTOMER_AREA }) : null;
    },
    keyHash: (id) => opaqueDedupeToken(`${id.kind}:${id.normalized}`),
    clock: REAL_SUBJECT_CLOCK,
  };
}

/** The customers flag gates extraction itself: OFF ⇒ the question is handled exactly as before P5. */
export const isSubjectResolutionEnabled = (): boolean => platformAiPackEnabled("customers");
