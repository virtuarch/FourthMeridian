/**
 * lib/notifications/automations/facts.ts  (Comms Center B2 — the recorded TRIGGER FACTS)
 *
 * The engine fires only on facts that are already RECORDED: the AuditLog rows
 * the typed domain-event seam writes (lib/events/emit.ts emitDomainEvent). A
 * trigger is engine-available only when it has an entry here AND the trigger
 * catalog says AVAILABLE (rules.ts engineTriggerAvailable). There is no other
 * way in: no endpoint accepts an event, no operator supplies a payload, and no
 * code is evaluated — the map below is the whole vocabulary.
 *
 * LOOP PREVENTION (v1 §5.7, v1.1 §6.7) is structural:
 *   · every source is a DOMAIN action (a member was invited / joined / removed /
 *     changed role) — never a comms action. `assertNotCommsAction` refuses, at
 *     module load, any source whose action is a COMMS_* / NOTIFICATION_* / EMAIL_*
 *     audit action, so an automation can never trigger on a send, a delivery,
 *     a read or an operator's comms action;
 *   · the engine writes NO AuditLog row for anything it sends (engine decisions
 *     are ledger rows and run counts, v1 §5.8), and createNotification /
 *     sendEmail write none either — so a send can never become a fact here.
 *
 * PAYLOAD: only the fields the trigger catalog declares are copied, and never a
 * PII field (removedName / targetName / invitedEmail stay in the audit row).
 */

import type { TriggerKey } from "@/lib/notifications/catalog/types";
import { TRIGGER_CATALOG } from "@/lib/notifications/catalog/triggers";

/** One recorded trigger fact, as the engine sees it. */
export interface TriggerFact {
  /** The AuditLog row id — the opaque triggerRef. */
  ref: string;
  triggerKey: TriggerKey;
  occurredAt: Date;
  actorUserId: string | null;
  subjectUserId: string | null;
  spaceId: string | null;
  /** Catalog-declared, non-PII payload fields only. */
  payload: Record<string, string | number | boolean>;
}

export interface FactSource {
  /** The AuditLog action whose rows ARE this trigger's facts. */
  action: string;
  /** The metadata field naming the user the event is ABOUT (EVENT_SUBJECT_USER). */
  subjectField: string;
}

/** The engine-readable triggers. Closed; keyed by the catalog's TriggerKey. */
export const FACT_SOURCES: Partial<Record<TriggerKey, FactSource>> = {
  "space.member.invited": { action: "MEMBER_INVITED", subjectField: "invitedUserId" },
  "space.member.joined": { action: "MEMBER_JOINED", subjectField: "userId" },
  "space.member.removed": { action: "MEMBER_REMOVED", subjectField: "removedUserId" },
  "space.member.role_changed": { action: "MEMBER_ROLE_CHANGED", subjectField: "targetUserId" },
};

const COMMS_ACTION = /^(COMMS_|NOTIFICATION|EMAIL_|CUSTOMER_DELIVERY)/;

/** Throws when a source would let a comms-originated action become a trigger. */
export function assertNotCommsAction(sources: Partial<Record<TriggerKey, FactSource>>): void {
  for (const [k, s] of Object.entries(sources)) {
    if (s && COMMS_ACTION.test(s.action)) throw new Error(`automation facts: trigger ${k} would fire on a comms action (${s.action})`);
  }
}
assertNotCommsAction(FACT_SOURCES);

export interface AuditFactRow {
  id: string;
  action: string;
  userId: string | null;
  spaceId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/** PURE — an AuditLog row → the fact (null when it is not this trigger's, or names no subject). */
export function toFact(trigger: TriggerKey, row: AuditFactRow): TriggerFact | null {
  const src = FACT_SOURCES[trigger];
  if (!src || row.action !== src.action) return null;
  const md = typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>) : {};
  const payload: Record<string, string | number | boolean> = {};
  for (const f of TRIGGER_CATALOG[trigger].payload) {
    if (f.pii) continue;
    const v = f.name === "spaceId" ? row.spaceId : md[f.name];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") payload[f.name] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  const subject = md[src.subjectField];
  return {
    ref: row.id,
    triggerKey: trigger,
    occurredAt: row.createdAt,
    actorUserId: row.userId,
    subjectUserId: typeof subject === "string" && subject.length > 0 ? subject : null,
    spaceId: row.spaceId,
    payload,
  };
}

export interface FactReadClient {
  auditLog: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: Array<Record<string, "asc" | "desc">>;
      take: number;
      select: { id: true; action: true; userId: true; spaceId: true; metadata: true; createdAt: true };
    }): Promise<AuditFactRow[]>;
    findUnique(args: { where: { id: string }; select: { id: true; action: true; userId: true; spaceId: true; metadata: true; createdAt: true } }): Promise<AuditFactRow | null>;
  };
}

const SELECT = { id: true, action: true, userId: true, spaceId: true, metadata: true, createdAt: true } as const;

/**
 * Facts strictly AFTER the keyset cursor (createdAt, id), oldest first, at most
 * `take` — the engine's resumable scan. `until` bounds the replay window.
 */
export async function readFactsAfter(
  client: FactReadClient,
  trigger: TriggerKey,
  cursor: { at: Date; id: string | null },
  take: number,
  until?: Date,
): Promise<TriggerFact[]> {
  const src = FACT_SOURCES[trigger];
  if (!src) return [];
  const after = cursor.id
    ? { OR: [{ createdAt: { gt: cursor.at } }, { createdAt: cursor.at, id: { gt: cursor.id } }] }
    : { createdAt: { gte: cursor.at } };
  const rows = await client.auditLog.findMany({
    where: { action: src.action, AND: [after, ...(until ? [{ createdAt: { lte: until } }] : [])] },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
    select: SELECT,
  });
  return rows.map((r) => toFact(trigger, r)).filter((f): f is TriggerFact => f !== null);
}

/** One fact by its ref (send-time re-evaluation and single-ref dry runs). */
export async function readFact(client: FactReadClient, trigger: TriggerKey, ref: string): Promise<TriggerFact | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) return null;
  const row = await client.auditLog.findUnique({ where: { id: ref }, select: SELECT });
  return row ? toFact(trigger, row) : null;
}
