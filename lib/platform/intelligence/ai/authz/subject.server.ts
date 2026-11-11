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
import { INCIDENT_CS_AREA, INCIDENT_OPS_AREA, INCIDENT_RECORD_KIND, INCIDENT_RID } from "../tools/packs/incidents";
import { REAL_SUBJECT_CLOCK, SUBJECT_LIMIT, SUBJECT_LIMITER_NAME, type SubjectDeps, type SubjectFlags, type SubjectIdentifier } from "./subject";

/** The Production lookup for one exact identifier (customer population only). */
export async function lookupCustomerSubject(id: SubjectIdentifier): Promise<string | null> {
  switch (id.kind) {
    case "EMAIL": return findCustomerByEmail(id.normalized);
    case "USER_ID": return findCustomerById(id.normalized);
    case "OPAQUE_REF": return findCustomerByRefToken(id.normalized.slice("user #".length));
  }
}

/**
 * P8 — an exact incident id → a handle of THIS turn, per the incident audience rules: the CUSTOMER_SUCCESS
 * area first (its CS tier — the CS tools can then investigate it), else PLATFORM_OPS (OPS tier); each a fresh
 * recheck + the INCIDENT source's revalidate (boundary adoptRecord). null ⇒ not an incident this operator sees.
 */
export const INCIDENT_SUBJECT_AREAS: readonly PlatformArea[] = [INCIDENT_CS_AREA, INCIDENT_OPS_AREA];

export function platformAiSubjectDeps(input: { operatorId: string; primaryArea: PlatformArea; boundary: Pick<TurnBoundary, "subjectEligibility" | "adoptSubject" | "adoptRecord"> }): SubjectDeps {
  return {
    // P8 (PACK-PR-CONDITIONS 8): incident ids are disambiguated only while the incidents flag is ON.
    ...(platformAiPackEnabled("incidents") ? {
      incident: { resolve: (incidentId: string) => (INCIDENT_RID.test(incidentId) ? input.boundary.adoptRecord({ rk: INCIDENT_RECORD_KIND, rid: incidentId }, INCIDENT_SUBJECT_AREAS) : Promise.resolve(null)) },
    } : {}),
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

/** The pack flags subject resolution follows (each strict, default OFF). */
export const platformAiSubjectFlags = (): SubjectFlags => ({ customers: platformAiPackEnabled("customers"), incidents: platformAiPackEnabled("incidents") });

/**
 * The customers OR (P8) incidents flag gates extraction itself: both OFF ⇒ the question is handled exactly as
 * before P5. Incidents ON with customers OFF ⇒ only incident ids resolve; every other identifier gets the scrub's
 * own text (authz/subject.ts PASSTHROUGH — no lookup, no audit).
 */
export const isSubjectResolutionEnabled = (): boolean => platformAiPackEnabled("customers") || platformAiPackEnabled("incidents");
