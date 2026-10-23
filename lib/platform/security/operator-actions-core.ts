/**
 * lib/platform/security/operator-actions-core.ts  (P1 — operator action feed)
 *
 * PURE projection of an operator AuditLog row into what the Security Ops feed
 * shows. Reads the P1 operator-action envelope (lib/audit.ts: actor / target /
 * reason / change / execution / result) when a row has it and falls back to the
 * pre-P1 ad hoc metadata keys when it does not.
 *
 * PRIVACY POSTURE (unchanged from PO-3A, now pinned here): the feed shows the
 * acting operator's username, the action, a COARSE target (subject username, or
 * `<kind> …<last 6 of id>`), the reason CODE, the result, and opaque execution
 * references. It never shows the reason NOTE (Customer Success only), never
 * email / IP / user-agent, never metadata verbatim.
 */

export interface OperatorAuditRowLike {
  id: string;
  action: string;
  createdAt: Date;
  performedByAdminId: string | null;
  metadata: unknown;
  /** The SUBJECT (userId) username, when the row has one. */
  subjectUsername: string | null;
}

export interface OperatorActionEvent {
  id: string;
  action: string;
  at: string;               // ISO
  operator: string;         // acting operator's username, or "operator"
  target: string | null;    // subject username or an opaque `<kind> …<tail>` / non-PII token
  reasonCode: string | null;
  result: "SUCCESS" | "FAILURE" | "REFUSED" | null;
  execution: { jobRunId?: string; refreshExecutionId?: string; commandId?: string } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** `<kind> …<last 6>` — enough to correlate, never resolvable to a person here. */
export function opaqueTargetLabel(kind: string, id: string): string {
  return `${kind} …${id.slice(-6)}`;
}

/** Pre-P1 rows: a coarse non-PII token from the ad hoc keys (never email). */
function legacyTargetLabel(m: Record<string, unknown>): string | null {
  for (const key of ["institution", "commandId", "targetJob", "area", "level"]) {
    const v = str(m[key]);
    if (v) return v;
  }
  return null;
}

export function projectOperatorActionEvent(row: OperatorAuditRowLike, operatorName: string | null): OperatorActionEvent {
  const m = isRecord(row.metadata) ? row.metadata : {};
  const target = isRecord(m.target) && str(m.target.kind) && str(m.target.id) ? { kind: m.target.kind as string, id: m.target.id as string } : null;
  const reason = isRecord(m.reason) ? str(m.reason.code) : null;
  const result = m.result === "SUCCESS" || m.result === "FAILURE" || m.result === "REFUSED" ? m.result : null;
  let execution: OperatorActionEvent["execution"] = null;
  if (isRecord(m.execution)) {
    const e = m.execution;
    const picked = {
      ...(str(e.jobRunId) ? { jobRunId: e.jobRunId as string } : {}),
      ...(str(e.refreshExecutionId) ? { refreshExecutionId: e.refreshExecutionId as string } : {}),
      ...(str(e.commandId) ? { commandId: e.commandId as string } : {}),
    };
    execution = Object.keys(picked).length ? picked : null;
  }
  return {
    id: row.id,
    action: row.action,
    at: row.createdAt.toISOString(),
    operator: operatorName ?? "operator",
    target: row.subjectUsername
      ?? (target ? (target.kind === "USER" ? opaqueTargetLabel("user", target.id) : opaqueTargetLabel(target.kind.toLowerCase().replace("_", " "), target.id)) : legacyTargetLabel(m)),
    reasonCode: reason,
    result,
    execution,
  };
}
