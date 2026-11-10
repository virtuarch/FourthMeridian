/**
 * lib/platform/intelligence/ai/tools/packs/incidents.server.ts  (Platform AI P8 — the incidents pack's Production readers)
 *
 * The EXISTING incident accessors, unchanged, behind tools/packs/incidents.ts:
 *   brokenNow / needsVerification / search / investigate   lib/platform/incidents/intelligence incidentAccessors
 * Every read takes the audience token of THIS call's fresh guard (authz/recheck.server.ts minted it from the
 * guard result — the guard-provenance pin); this file mints nothing and imports token TYPES only.
 * The CS records' customer reference = the keyed opaque ref (the customers pack's PRIV-ref rid → "user #…").
 *
 * Also here: the INCIDENT record source the read-time renderer, replay re-authz and subject adoption use
 * (authz/record-render.ts PLATFORM_AI_RECORD_SOURCES):
 *   revalidate  the incident is visible to THIS fresh guard's token on its own area: PLATFORM_OPS ⇒ OPS,
 *               CUSTOMER_SUCCESS (fresh CS tier + CS token) ⇒ CUSTOMER_SUCCESS; else null;
 *   t1          a CODE-DERIVED label (sync-issue-semantics.ts incidentLabel(kind, domain)) — never the
 *               verdict's `label` (which may embed an account label);
 *   linkedUserIds / t2   CS only: the verdict's subjectUserId, then that customer's name / email (within the
 *               customer population) — read ONLY by the renderer after its fresh CS check and the
 *               PLATFORM_AI_RECORD_VIEWED row.
 * Never logs.
 */

import "server-only";

import type { PlatformArea } from "@prisma/client";
import { systemDb } from "@/lib/db";
import { incidentAccessors, type CsToken, type OpsToken } from "@/lib/platform/incidents/intelligence";
import type { CsIncidentVerdict, IncidentAccessors, IncidentVerdict } from "@/lib/platform/incidents/intelligence/types";
import { incidentLabel, type SyncIssueDomain } from "@/lib/platform/sync-issue-semantics";
import type { RecordRenderSource } from "../../authz/record-render";
import type { FreshGuard } from "../../authz/recheck";
import type { T2FieldName } from "../../evidence/record-envelope";
import type { ToolTier } from "../contract";
import { refOfRid } from "./customers";
import { customerRid, findCustomerById } from "./customers.server";
import { INCIDENT_CS_AREA, INCIDENT_OPS_AREA, INCIDENT_RID, incidentsPackTools, type IncidentsPackReaders, type IncidentsToolContext } from "./incidents";

type Accessors = Pick<IncidentAccessors, "brokenNow" | "needsVerification" | "search" | "investigate" | "detail">;
type Client = typeof systemDb;

/** The keyed T1 reference of a customer ("user #" + 8 hex), or null without the server key. */
export function incidentCustomerRef(userId: string): string | null {
  const rid = customerRid(userId);
  return rid ? refOfRid(rid) : null;
}

export function incidentsPackReaders(acc: Accessors = incidentAccessors): IncidentsPackReaders {
  return {
    brokenNow: (token, now) => acc.brokenNow(token, { now }),
    needsVerification: (token, now) => acc.needsVerification(token, { now }),
    search: (token, query, now) => acc.search(token, query, { now }),
    investigate: (token, id, now) => acc.investigate(token, id, { now }),
    customerRef: incidentCustomerRef,
    now: () => new Date(),
  };
}

/** The Production incidents-pack tools (tools/registry.ts). */
export const INCIDENTS_PACK_TOOLS = incidentsPackTools<IncidentsToolContext>(incidentsPackReaders());

/** The token THIS guard holds for the record's area, and the tier it reads at — or null (no read). */
function tokenFor(area: PlatformArea, guard: FreshGuard | undefined): { token: OpsToken | CsToken; tier: ToolTier } | null {
  const t = guard?.incidentToken;
  if (!guard || !t) return null;
  if (area === INCIDENT_OPS_AREA && t.audience === "PLATFORM_OPS") return { token: t, tier: "OPS" };
  if (area === INCIDENT_CS_AREA && guard.csTier === true && t.audience === "CUSTOMER_SUCCESS") return { token: t, tier: "CUSTOMER_SUCCESS" };
  return null;
}

/** The INCIDENT record kind's read-time source. Every method reads fresh, with the guard's own token. */
export function incidentRecordSource(acc: Accessors = incidentAccessors, client: Client = systemDb): RecordRenderSource {
  const T2: readonly T2FieldName[] = ["name", "email"];
  // A live row first (one id), else the archive summary (investigate reads both). Never a raw SyncIssue read.
  const verdictOf = async (rid: string, area: PlatformArea, guard: FreshGuard | undefined): Promise<(IncidentVerdict | CsIncidentVerdict) | null> => {
    const t = tokenFor(area, guard);
    if (!t || typeof rid !== "string" || !INCIDENT_RID.test(rid)) return null;
    const v = (await acc.detail(t.token, rid)) ?? (await acc.investigate(t.token, rid))?.verdict ?? null;
    return v && v.id === rid && v.rowClass === "incident" ? v : null;
  };
  const subjectOf = (v: IncidentVerdict | CsIncidentVerdict | null): string | null =>
    (v && "subjectUserId" in v && typeof v.subjectUserId === "string" && v.subjectUserId.length > 0 ? v.subjectUserId : null);
  return {
    t2Fields: T2,
    async revalidate(rid, area, guard) {
      const t = tokenFor(area, guard);
      return t && (await verdictOf(rid, area, guard)) ? t.tier : null;
    },
    async t1(rid, area, guard) {
      const v = await verdictOf(rid, area, guard);
      return v ? `incident: ${incidentLabel(v.kind, v.domain as SyncIssueDomain)}` : null;
    },
    async linkedUserIds(rid, area, guard) {
      const v = await verdictOf(rid, area, guard);
      if (!v) throw new Error("incident not resolvable");
      if (area !== INCIDENT_CS_AREA) return [];
      const u = subjectOf(v);
      return u ? [u] : [];
    },
    async t2(rid, area, field, guard) {
      if (area !== INCIDENT_CS_AREA || !T2.includes(field)) return null;
      const u = subjectOf(await verdictOf(rid, area, guard));
      const id = u ? await findCustomerById(u, client) : null;
      if (!id) return null;
      const row = await client.user.findUnique({ where: { id }, select: { name: true, email: true } });
      if (!row) return null;
      return field === "email" ? row.email : row.name;
    },
  };
}
