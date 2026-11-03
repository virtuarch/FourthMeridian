/**
 * lib/platform/incidents/phase1.test.ts  (PB-1 Phase 1 — data model, pure + fake-client)
 *
 * Invariant rules for the new kinds and columns · the per-subject removal rule
 * (§12 P2.2) · the typed evidence builder and the SKIPPED-is-never-proof pin
 * (§12 P2.1) · the archive allowlist leak test · the code registries · the
 * SUBJECT_REMOVED closure (CAS in one transaction, throw on 0, event after the
 * update, owner + refs captured, never a recovery) · the observation writers
 * (subjectUserId, structured occurrence subjects, job link, OBSERVED once).
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/phase1.test.ts
 */

import { lifecycleViolation, RESOLUTION_KINDS, isRemovedSubjectEvidence } from "./invariant";
import { subjectVerdict, type SubjectFacts } from "./subjects-core";
import { buildResolutionEvidence, mayAdvanceRecovery, buildOccurrenceEvidenceSummary, reshapeStoredEvidence, EVIDENCE_MAX_BYTES } from "./evidence";
import { buildArchiveRow, buildEventTimeline, ARCHIVE_ROW_KEYS } from "./archive-core";
import { ALL_CODE_REGISTRIES, CODE_PATTERN } from "./codes";
import {
  resolveBySubjectRemoval, recordIncidentObservation, eventData,
  RESOLUTION_KIND_SUBJECT_REMOVED, type RemovalClient, type IncidentClient,
} from "./lifecycle";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, o); }
};

const NOW = new Date("2026-11-03T12:00:00Z");
const base = { resolved: true, resolvedAt: NOW, resolvingExecutionId: null, incidentKey: null };
const removedEvidence = { subject: { kind: "FINANCIAL_ACCOUNT", id: "fa1", state: "DELETED", observedAt: NOW.toISOString() } };

async function main() {
  console.log("1. invariant — the new kinds and columns");
  {
    check("kinds are exactly the three", RESOLUTION_KINDS.join() === "AUTOMATIC_RECOVERY,OPERATOR_RESOLVED,SUBJECT_REMOVED");
    check("an unknown kind is refused", lifecycleViolation("condition", { ...base, resolutionKind: "FIXED_ITSELF" }) !== null);
    check("OPERATOR_RESOLVED needs resolvedById", /resolvedById/.test(lifecycleViolation("condition", { ...base, resolutionKind: "OPERATOR_RESOLVED", resolutionAuditId: "a" }) ?? ""));
    check("OPERATOR_RESOLVED needs resolutionAuditId", /resolutionAuditId/.test(lifecycleViolation("condition", { ...base, resolutionKind: "OPERATOR_RESOLVED", resolvedById: "u" }) ?? ""));
    check("OPERATOR_RESOLVED with both is sound", lifecycleViolation("condition", { ...base, resolutionKind: "OPERATOR_RESOLVED", resolvedById: "u", resolutionAuditId: "a" }) === null);
    check("SUBJECT_REMOVED needs resolutionEvidence.subject", /subject/.test(lifecycleViolation("condition", { ...base, resolutionKind: "SUBJECT_REMOVED" }) ?? ""));
    check("SUBJECT_REMOVED never names a resolving execution",
      /resolvingExecutionId/.test(lifecycleViolation("condition", { ...base, resolutionKind: "SUBJECT_REMOVED", resolvingExecutionId: "x", resolutionEvidence: removedEvidence }) ?? ""));
    check("SUBJECT_REMOVED with evidence is sound", lifecycleViolation("condition", { ...base, resolutionKind: "SUBJECT_REMOVED", resolutionEvidence: removedEvidence, lifecycleState: "RESOLVED" }) === null);
    check("a LIVE subject is not removal evidence", !isRemovedSubjectEvidence({ subject: { ...removedEvidence.subject, state: "LIVE" } }));
    check("lifecycleState must move with resolved", lifecycleViolation("condition", { ...base, resolutionKind: "AUTOMATIC_RECOVERY", lifecycleState: "ACTIVE" }) !== null);
    check("an unknown lifecycleState is refused", lifecycleViolation("condition", { resolved: false, resolvedAt: null, resolutionKind: null, resolvingExecutionId: null, incidentKey: "k", lifecycleState: "REOPENED" }) !== null);
    check("an active condition carries no operator resolution",
      lifecycleViolation("condition", { resolved: false, resolvedAt: null, resolutionKind: null, resolvingExecutionId: null, incidentKey: "k", resolvedById: "u" }) !== null);
    check("an EVENT carries no lifecycleState", lifecycleViolation("event", { resolved: true, resolvedAt: null, resolutionKind: null, resolvingExecutionId: null, incidentKey: null, lifecycleState: "RESOLVED" }) !== null);
  }

  console.log("\n2. the per-subject removal rule (§5 + §12 P2.2)");
  {
    const facts: SubjectFacts = {
      itemStatus: new Map([["item-live", "ACTIVE"], ["item-revoked", "REVOKED"]]),
      accountDeletedAt: new Map([["acct-live", null], ["acct-gone", NOW], ["acct-gone-2", NOW]]),
    };
    check("account-scoped, account soft-deleted → SUBJECT_REMOVED (DELETED)",
      (() => { const v = subjectVerdict({ plaidItemId: null, financialAccountId: "acct-gone" }, facts); return v.verdict === "SUBJECT_REMOVED" && v.subject.state === "DELETED"; })());
    check("account-scoped, row missing → SUBJECT_REMOVED (MISSING)",
      (() => { const v = subjectVerdict({ plaidItemId: null, financialAccountId: "nope" }, facts); return v.verdict === "SUBJECT_REMOVED" && v.subject.state === "MISSING"; })());
    check("account-scoped, account live → OPEN", subjectVerdict({ plaidItemId: null, financialAccountId: "acct-live" }, facts).verdict === "OPEN");
    check("item revoked → SUBJECT_REMOVED (REVOKED), whatever its accounts",
      (() => { const v = subjectVerdict({ plaidItemId: "item-revoked", financialAccountId: "acct-live" }, facts); return v.verdict === "SUBJECT_REMOVED" && v.subject.state === "REVOKED"; })());
    check("item live, no account subject → OPEN (item-level work is not removed)", subjectVerdict({ plaidItemId: "item-live", financialAccountId: null }, facts).verdict === "OPEN");
    check("item live, EVERY occurrence account removed → SUBJECT_REMOVED",
      subjectVerdict({ plaidItemId: "item-live", financialAccountId: "acct-gone" }, facts, ["acct-gone-2"]).verdict === "SUBJECT_REMOVED");
    check("item live, one occurrence account still live → OPEN (not proven, not removed)",
      subjectVerdict({ plaidItemId: "item-live", financialAccountId: "acct-gone" }, facts, ["acct-live"]).verdict === "OPEN");
    check("item live, the live one PROVEN and the rest removed → AUTOMATIC_RECOVERY (S4/S5 supply proof)",
      subjectVerdict({ plaidItemId: "item-live", financialAccountId: "acct-gone" }, facts, ["acct-live"], new Set(["acct-live"])).verdict === "AUTOMATIC_RECOVERY");
    check("no subject at all → UNSCOPED (nothing to remove)", subjectVerdict({ plaidItemId: null, financialAccountId: null }, facts).verdict === "UNSCOPED");
  }

  console.log("\n3. evidence — typed, capped, and a SKIP is never proof (§12 P2.1)");
  {
    const skipped = buildResolutionEvidence({ rule: "WALLET_PRICE_V1", facts: [
      { source: "RefreshEndpointResult", executionId: "e1", endpoint: "VALUATION", status: "SKIPPED", skipReason: "BUDGET", completedAt: NOW.toISOString() },
      { source: "RefreshEndpointResult", executionId: "e2", endpoint: "VALUATION", status: "NOT_ATTEMPTED", completedAt: null },
    ] });
    check("SKIPPED / NOT_ATTEMPTED are recorded as nonProof", skipped.nonProof.length === 2 && skipped.proof.length === 0 && skipped.proofCount === 0);
    check("a SKIPPED-only record can NEVER advance to RECOVERING / RESOLVED", mayAdvanceRecovery(skipped) === false);
    check("…not even if someone inflates proofCount", mayAdvanceRecovery({ ...skipped, proofCount: 2 }) === false);
    const proven = buildResolutionEvidence({ rule: "WALLET_PRICE_V1", facts: [{ source: "RefreshEndpointResult", executionId: "e3", endpoint: "VALUATION", status: "SUCCEEDED", completedAt: NOW.toISOString() }] });
    check("a SUCCEEDED fact is proof", mayAdvanceRecovery(proven) && proven.proofCount === 1);
    const smuggled = buildResolutionEvidence({ rule: "R_V1", facts: [{ source: "RefreshEndpointResult", executionId: "e", endpoint: "WALLET_SYNC", status: "FAILED", completedAt: null, errorSummary: "Bank said: secret", detail: { m: "x" } } as never] });
    check("the builder copies its allowlist only (no smuggled fields)", !JSON.stringify(smuggled).includes("secret") && !JSON.stringify(smuggled).includes("detail"));
    let threw = false;
    try { buildResolutionEvidence({ rule: "R_V1", subjects: Array.from({ length: 400 }, (_, i) => ({ kind: "FINANCIAL_ACCOUNT" as const, id: `account-${i}-${"x".repeat(60)}`, state: "DELETED" as const })) }); }
    catch { threw = true; }
    check(`the subject list is truncated, never over the ${EVIDENCE_MAX_BYTES} B cap`, !threw);
    const summary = buildOccurrenceEvidenceSummary({ executionId: "e", runId: "r", jobRunId: "j", jobName: "sync-banks", stage: "price" });
    check("occurrence evidenceSummary carries ids only", Object.keys(summary).join() === "executionId,runId,jobRunId,jobName,stage");
  }

  console.log("\n4. the archive — allowlist only; provider text and `detail` can never reach it");
  {
    const leaky = {
      id: "si_1", incidentKey: "v1::WALLET::FINANCIAL_ACCOUNT:fa1::wallet::price",
      provider: "WALLET: upstream said SECRET_PROVIDER_TEXT", kind: "WALLET_SYNC_FAILED",
      plaidItemId: null, financialAccountId: "fa1", subjectUserId: "u1", previousIncidentId: null,
      firstOccurredAt: NOW, lastOccurredAt: NOW, resolvedAt: NOW, resolutionKind: "SUBJECT_REMOVED",
      resolutionReasonCode: "SUBJECT_DELETED; DROP TABLE", causeStatus: "CONFIRMED", causeCode: "provider said no",
      resolutionEvidence: { rule: "SUBJECT_REMOVED_V1", proof: [], nonProof: [], proofCount: 0, detail: { merchant: "SECRET_MERCHANT" }, message: "SECRET_PROVIDER_TEXT",
        subject: { kind: "FINANCIAL_ACCOUNT", id: "fa1", state: "DELETED", observedAt: NOW.toISOString(), note: "SECRET_PROVIDER_TEXT" } },
      occurrenceCount: 3,
      // Fields the input type does not have — must be dropped even if a caller passes them.
      detail: { merchant: "SECRET_MERCHANT", error: "SECRET_PROVIDER_TEXT" },
    };
    const row = buildArchiveRow(leaky as never, [
      { type: "OBSERVED", at: NOW, fromState: null, toState: null, causeCode: "free text here", actionCode: null, outcomeCode: null },
      { type: "STATE_CHANGED", at: NOW, fromState: "ACTIVE", toState: "RESOLVED", causeCode: null, actionCode: null, outcomeCode: null },
    ]);
    const text = JSON.stringify(row);
    check("no provider string reaches the archive", !text.includes("SECRET_PROVIDER_TEXT") && row.provider === "UNKNOWN", row.provider);
    check("no `detail` fragment reaches the archive", !text.includes("SECRET_MERCHANT") && !("detail" in row));
    check("non-registry codes are dropped, never stored", row.resolutionReasonCode === null && row.causeCode === null);
    check("the evidence copy is re-built by the typed builder", (row.resolutionEvidence as { subject?: { note?: string } } | null)?.subject?.note === undefined
      && (row.resolutionEvidence as { rule?: string } | null)?.rule === "SUBJECT_REMOVED_V1");
    check("the column set is the pinned allowlist", Object.keys(row).sort().join() === [...ARCHIVE_ROW_KEYS].sort().join());
    check("operation comes from the key", row.operation === "price");
    check("the timeline is code-only (free text in a code field dropped)",
      !text.includes("free text") && row.eventTimeline?.events.length === 2 && row.eventTimeline.events[1].toState === "RESOLVED");
    const many = Array.from({ length: 500 }, (_, i) => ({ type: "STATE_CHANGED", at: new Date(NOW.getTime() + i), fromState: "ACTIVE", toState: "ACKNOWLEDGED", causeCode: null, actionCode: "ACKNOWLEDGE", outcomeCode: "SUCCEEDED" }));
    const tl = buildEventTimeline(many);
    check("the timeline is capped under 8192 B, oldest dropped, marked truncated",
      !!tl && tl.truncated && Buffer.byteLength(JSON.stringify(tl)) <= 8192 && tl.events.at(-1)!.at === new Date(NOW.getTime() + 499).toISOString());
    check("a garbage stored evidence is dropped, not copied", reshapeStoredEvidence({ rule: "free text", x: 1 }) === null);
  }

  console.log("\n5. codes and events");
  {
    for (const [name, codes] of Object.entries(ALL_CODE_REGISTRIES)) {
      check(`${name}: every code matches the DB CHECK`, codes.every((c) => CODE_PATTERN.test(c)), codes.filter((c) => !CODE_PATTERN.test(c)).join());
    }
    const bad = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
    check("an OPERATOR event needs actorId + auditId", bad(() => eventData({ incidentId: "i", type: "ACTION_TAKEN", actorKind: "OPERATOR", actorId: "u" })));
    check("a SYSTEM event carries no actorId", bad(() => eventData({ incidentId: "i", type: "OBSERVED", actorKind: "SYSTEM", actorId: "u" })));
    check("CAUSE_RETRACTED names the event it retracts", bad(() => eventData({ incidentId: "i", type: "CAUSE_RETRACTED", actorKind: "SYSTEM" })));
    check("free text in a code field is refused", bad(() => eventData({ incidentId: "i", type: "NOTE_CODE", actorKind: "SYSTEM", outcomeCode: "it broke" })));
    check("the event row never carries `at` (the database stamps it)", !("at" in eventData({ incidentId: "i", type: "OBSERVED", actorKind: "SYSTEM" })));
  }

  console.log("\n6. SUBJECT_REMOVED closure — CAS in one transaction, then the event");
  {
    type Row = { id: string; kind: string; provider: string; detail: unknown; plaidTransactionId: null; plaidItemId: string | null; financialAccountId: string | null; lifecycleState: string | null; subjectUserId: string | null; resolved: boolean; data?: Record<string, unknown> };
    const make = (rows: Row[], opts: { casMisses?: Set<string> } = {}) => {
      const log: string[] = [];
      const events: Record<string, unknown>[] = [];
      const syncIssue = {
        findMany: async () => rows.filter((r) => !r.resolved),
        updateMany: async ({ where, data }: { where: { id: string; lifecycleState: string | null }; data: Record<string, unknown> }) => {
          log.push(`update:${where.id}`);
          if (opts.casMisses?.has(where.id)) return { count: 0 };
          const r = rows.find((x) => x.id === where.id && !x.resolved && x.lifecycleState === where.lifecycleState);
          if (!r) return { count: 0 };
          r.resolved = true; r.data = data; return { count: 1 };
        },
      };
      const syncIssueEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { log.push(`event:${data.incidentId}`); events.push(data); return { id: "ev" }; } };
      const client = {
        syncIssue, syncIssueEvent,
        syncIssueOccurrence: { findMany: async () => [] },
        financialAccount: { findMany: async () => [
          { id: "acct-gone", deletedAt: NOW, ownerUserId: "owner-1", createdByUserId: null },
          { id: "acct-live", deletedAt: null, ownerUserId: "owner-2", createdByUserId: null },
        ] },
        plaidItem: { findMany: async () => [] },
        $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
          const snapshot = rows.map((r) => ({ ...r }));
          try { return await fn({ syncIssue, syncIssueEvent }); }
          catch (e) { rows.splice(0, rows.length, ...snapshot); log.push("rollback"); throw e; }
        },
      } as unknown as RemovalClient;
      return { client, log, events };
    };
    const rowOf = (id: string, acct: string, extra: Partial<Row> = {}): Row => ({
      id, kind: "WALLET_SYNC_FAILED", provider: "WALLET", detail: { stage: "price" }, plaidTransactionId: null,
      plaidItemId: null, financialAccountId: acct, lifecycleState: null, subjectUserId: null, resolved: false, ...extra,
    });
    const rows = [rowOf("si-gone", "acct-gone"), rowOf("si-live", "acct-live")];
    const { client, log, events } = make(rows);
    const reported: string[] = [];
    const r = await quiet(() => resolveBySubjectRemoval({ financialAccountIds: ["acct-gone", "acct-live"] }, client, { onWriteFailure: (t, p) => reported.push(`${t}:${p}`) }));
    const gone = rows.find((x) => x.id === "si-gone")!;
    check("only the removed subject's incident closes", r.resolved === 1 && gone.resolved && !rows.find((x) => x.id === "si-live")!.resolved);
    check("closed as SUBJECT_REMOVED with a registry reason and lifecycleState RESOLVED — never AUTOMATIC_RECOVERY",
      gone.data?.resolutionKind === RESOLUTION_KIND_SUBJECT_REMOVED && gone.data?.resolutionReasonCode === "SUBJECT_DELETED"
      && gone.data?.lifecycleState === "RESOLVED" && gone.data?.resolvingExecutionId === null);
    check("resolutionEvidence.subject {kind,id,state,observedAt}", isRemovedSubjectEvidence(gone.data?.resolutionEvidence));
    check("the owner is captured from the subject row BEFORE any hard delete (legacy row had none)", gone.data?.subjectUserId === "owner-1");
    check("the event is written AFTER the CAS, in the same transaction", log.join() === "update:si-gone,event:si-gone", log.join());
    check("the event is a SYSTEM STATE_CHANGED → RESOLVED", events[0]?.type === "STATE_CHANGED" && events[0]?.toState === "RESOLVED" && events[0]?.actorKind === "SYSTEM");
    check("no write failure reported on the happy path", reported.length === 0, reported.join());

    const rows2 = [rowOf("si-race", "acct-gone", { subjectUserId: "kept" })];
    const t2 = make(rows2, { casMisses: new Set(["si-race"]) });
    const f2: string[] = [];
    const r2 = await quiet(() => resolveBySubjectRemoval({ financialAccountIds: ["acct-gone"] }, t2.client, { onWriteFailure: (t, p) => f2.push(`${t}:${p}`) }));
    check("a 0-row CAS THROWS inside the transaction: no event, rolled back, REPORTED (never silent)",
      r2.resolved === 0 && t2.events.length === 0 && t2.log.includes("rollback") && f2.join() === "SyncIssue:resolution", `${t2.log} / ${f2}`);

    const txClient = { syncIssue: {}, syncIssueOccurrence: {} } as unknown as RemovalClient;
    const f3: string[] = [];
    await quiet(() => resolveBySubjectRemoval({ financialAccountIds: ["x"] }, txClient, { onWriteFailure: (t, p) => f3.push(`${t}:${p}`) }));
    check("a transaction-scoped client is refused (OPS-2D-TX-1)", f3.join() === "SyncIssue:resolution");
  }

  console.log("\n7. the observation writers");
  {
    const created: Record<string, unknown>[] = [];
    const occ: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    let nextId = 0;
    const client = {
      syncIssue: {
        findFirst: async () => null,
        create: async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: `si-${++nextId}` }; },
        update: async () => ({}),
      },
      syncIssueOccurrence: { create: async ({ data }: { data: Record<string, unknown> }) => { occ.push(data); return { id: `occ-${++nextId}` }; } },
      syncIssueEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return { id: "ev" }; } },
      $transaction: async () => { throw new Error("observation opens no transaction"); },
    } as unknown as IncidentClient;
    const res = await quiet(() => recordIncidentObservation({
      kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", plaidItemId: "item-1", detail: { stage: "reconstruction-repair" },
      subjectUserId: "owner-1", subjectAccountId: "acct-1", securityId: "sec-1", jobRunId: "jr-1", jobName: "sync-banks",
    }, client, async () => null));
    check("a new episode stores the owner and how it opened", created[0]?.subjectUserId === "owner-1" && created[0]?.openedBy === "OBSERVATION");
    check("lifecycleState stays NULL (derived) — no state machine yet", created[0]?.lifecycleState === undefined);
    check("the occurrence carries structured subjects + job link + a typed summary",
      occ[0]?.subjectAccountId === "acct-1" && occ[0]?.securityId === "sec-1" && occ[0]?.jobRunId === "jr-1" && occ[0]?.jobName === "sync-banks"
      && (occ[0]?.evidenceSummary as { jobName?: string })?.jobName === "sync-banks");
    check("OBSERVED is written once, at open, naming the occurrence",
      events.length === 1 && events[0]?.type === "OBSERVED" && events[0]?.occurrenceId === res?.occurrenceId && events[0]?.actorKind === "SYSTEM");

    // A second observation CONVERGES: no new episode, no second OBSERVED (occurrences are not mirrored).
    const conv = { ...client, syncIssue: { ...(client.syncIssue as object), findFirst: async () => ({ id: "si-1" }) } } as unknown as IncidentClient;
    await quiet(() => recordIncidentObservation({ kind: "INVESTMENT_DATA_PERSISTENCE_FAILED", plaidItemId: "item-1", detail: { stage: "reconstruction-repair" } }, conv, async () => null));
    check("a converging observation writes no event", events.length === 1, `${events.length}`);
  }

  if (failures > 0) { console.error(`\nphase1.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\nphase1.test: all passed.");
}

void main();
