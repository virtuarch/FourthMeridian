/**
 * lib/platform/activity/operator-feed.ts  (UX-P1 · D6 — the Platform Operations activity feed)
 *
 * THE LOADER for the narrow operator-activity feed. The Security Ops feed route
 * (app/api/platform/security-ops/operator-actions) reads AuditLog inline and is
 * SECURITY-scoped by construction — its action list is the whole operator
 * census and it joins the subject's username — so it cannot be parameterised
 * into this one without widening it. This module therefore performs the same
 * two bounded reads in the same shape, narrowed at the query:
 *
 *   · AuditLog rows whose action is in the D6 allowlist, newest first, capped
 *     at OPERATOR_FEED_DEPTH, selecting id / action / createdAt /
 *     performedByAdminId / metadata — and NO user relation, so a subject's
 *     username is never loaded, let alone shown;
 *   · the acting operators' username + name in ONE batched follow-up, folded
 *     through operatorDisplayName (username → name → opaque; never email).
 *
 * AUTHORITY: fm_system (`systemDb`), never the migration principal — the same
 * choice lib/platform/policies/job-cadence.ts made and for the same reason: a
 * new runtime importer of `db` grows the db-authority ratchet, and AuditLog +
 * User are both fm_system-readable. The route gates PLATFORM_OPS READ before
 * this runs.
 */

import "server-only";
import { systemDb } from "@/lib/db";
import { operatorDisplayName, type OperatorIdentityLike } from "@/lib/platform/customer/identity-label";
import {
  OPERATOR_FEED_DEPTH, PLATFORM_OPS_FEED_ACTIONS, buildOperatorFeed,
  type OperatorFeedResponse, type OperatorFeedRowLike,
} from "./operator-feed-core";

export interface OperatorFeedReaders {
  now(): Date;
  rows(actions: readonly string[], take: number): Promise<OperatorFeedRowLike[]>;
  operators(ids: readonly string[]): Promise<OperatorIdentityLike[]>;
}

function realReaders(): OperatorFeedReaders {
  return {
    now: () => new Date(),
    async rows(actions, take) {
      return systemDb.auditLog.findMany({
        where: { action: { in: [...actions] }, performedByAdminId: { not: null } },
        orderBy: { createdAt: "desc" },
        take,
        select: { id: true, action: true, createdAt: true, performedByAdminId: true, metadata: true },
      });
    },
    async operators(ids) {
      if (ids.length === 0) return [];
      return systemDb.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, username: true, name: true } });
    },
  };
}

export async function loadOperatorFeed(deps: { readers?: OperatorFeedReaders } = {}): Promise<OperatorFeedResponse> {
  const readers = deps.readers ?? realReaders();
  const now = readers.now();
  const rows = await readers.rows(PLATFORM_OPS_FEED_ACTIONS, OPERATOR_FEED_DEPTH);
  const operatorIds = [...new Set(rows.map((r) => r.performedByAdminId).filter((v): v is string => v != null))];
  const operators = await readers.operators(operatorIds);
  const label = new Map(operators.map((u) => [u.id, operatorDisplayName(u)] as const));
  return buildOperatorFeed(rows, (id) => label.get(id) ?? null, now.toISOString(), OPERATOR_FEED_DEPTH);
}
