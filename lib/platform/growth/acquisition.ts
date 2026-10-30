/**
 * lib/platform/growth/acquisition.ts  (Platform Spaces 2.0 — Growth: THE READER)
 *
 * Fetches the row sets lib/platform/growth/acquisition-core.ts folds, on
 * fm_system (`systemDb` — an operator reading fleet acquisition is outside every
 * tenancy; lib/platform/ is the allowlisted neighbourhood). Read-only.
 *
 * IDENTITY-FREE. The beta submissions are read through ONE raw SELECT that
 * returns md5(email) — the address never reaches the application, only a digest
 * that joins a requester's submissions. Every other select is ids and clocks.
 * The privacy scan (lib/platform/observability-privacy.test.ts) pins this file.
 *
 * BOUNDED. Every window read carries a row cap; a capped read is reported as a
 * note ("at least") rather than silently truncating a chart.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { AuditAction } from "@/lib/audit-actions";
import { boundAcquisitionSource } from "@/lib/marketing/acquisition";
import { loadActivityFacts, loadFunnelFacts } from "./product-analytics";
import { addDays, dayOf } from "./product-analytics-core";
import { buildAcquisition, cohortWeeks, type AcquisitionFacts } from "./acquisition-core";
import type { AcquisitionResponse } from "./acquisition-types";

export type AcquisitionDb = typeof systemDb;

/** Per-read row ceilings — far above the fleet today; a hit is disclosed, never hidden. */
export const ACQUISITION_ROW_CAP = 50_000;

const start = (day: string) => new Date(`${day}T00:00:00.000Z`);

export async function loadAcquisitionFacts(client: AcquisitionDb, now: Date, windowDays: 30 | 90): Promise<{ facts: AcquisitionFacts; capped: string[] }> {
  const today = dayOf(now);
  const since = start(addDays(today, -(windowDays - 1)));
  const cohortSince = start(cohortWeeks(today)[0]);

  const [requestRows, waitlist, logins, chat, funnel, activity] = await Promise.all([
    client.$queryRaw<{ k: string; at: Date; source: unknown }[]>`
      SELECT md5(lower(trim("email"))) AS k, "receivedAt" AS at, "source"
        FROM "BetaAccessRequestEvent"
       WHERE "receivedAt" >= ${since}
       ORDER BY "receivedAt" ASC
       LIMIT ${ACQUISITION_ROW_CAP}`,
    client.betaAccessRequest.findMany({ select: { status: true, inviteExpiresAt: true, invitedAt: true } }),
    client.auditLog.findMany({
      where: { action: AuditAction.LOGIN, createdAt: { gte: since } },
      select: { createdAt: true }, take: ACQUISITION_ROW_CAP,
    }),
    client.aiInvocation.findMany({
      where: { surface: "chat", userId: { not: null }, occurredAt: { gte: since } },
      select: { correlationId: true, turnIndex: true, occurredAt: true, userId: true }, take: ACQUISITION_ROW_CAP,
    }),
    loadFunnelFacts(client),
    loadActivityFacts(client, cohortSince),
  ]);

  const capped = [
    requestRows.length >= ACQUISITION_ROW_CAP ? "beta requests" : null,
    logins.length >= ACQUISITION_ROW_CAP ? "sign-ins" : null,
    chat.length >= ACQUISITION_ROW_CAP ? "AI chat turns" : null,
  ].filter((x): x is string => x !== null);

  return {
    facts: {
      requestEvents: requestRows.map((r) => ({
        requesterKey: r.k,
        receivedAt: r.at,
        source: boundAcquisitionSource(r.source),
      })),
      waitlist: waitlist.map((w) => ({ status: String(w.status), inviteExpiresAt: w.inviteExpiresAt, invitedAt: w.invitedAt })),
      logins: logins.map((l) => l.createdAt),
      chatTurns: chat.map((c) => ({
        // The product analytics' own turn key (product-analytics-core turnKey), so both pages count a turn alike.
        key: c.correlationId && c.turnIndex !== null ? `${c.correlationId}#${c.turnIndex}` : `${c.userId}|${dayOf(c.occurredAt)}|${c.occurredAt.toISOString()}`,
        at: c.occurredAt,
      })),
      funnel,
      activity,
    },
    capped,
  };
}

export async function getAcquisition(
  windowDays: 30 | 90,
  deps: { now?: Date; client?: AcquisitionDb } = {},
): Promise<AcquisitionResponse> {
  const now = deps.now ?? new Date();
  const { facts, capped } = await loadAcquisitionFacts(deps.client ?? systemDb, now, windowDays);
  const body = buildAcquisition(facts, now, windowDays);
  if (capped.length > 0) body.notes.push(`Read cap reached for ${capped.join(", ")} — those figures are a floor.`);
  return body;
}
