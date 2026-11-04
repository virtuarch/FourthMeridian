/**
 * lib/platform/incidents/operator-transition.test.ts  (PB-1 S6 — acknowledge / manual resolve)
 *
 * applyOperatorTransition against an in-memory client that models the CAS
 * (`updatedAt` moves on every write, like Prisma's @updatedAt), the audit row
 * and the transaction's rollback; then the route runner (operator-route.ts)
 * with injected deps. The B9-rollback constraints (S2 ruling) are asserted
 * behaviourally here and statically in incident-boundary.test.ts §12:
 *   (a) acknowledge leaves lifecycleState NULL; only RESOLVED is ever written;
 *   (b) nothing writes resolved=false on an existing row — a failure after a
 *       manual resolve opens a NEW episode linked by previousIncidentId.
 *
 * Run: npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/operator-transition.test.ts
 */

import { applyOperatorTransition, recordIncidentObservation, OPERATOR_RESOLVED_RULE, type IncidentClient, type OperatorTransitionClient } from "./lifecycle";
import { digestStoredEvidence, reshapeStoredEvidence, type ResolutionEvidence } from "./evidence";
import { lifecycleViolation } from "./invariant";
import { parseIncidentActionBody, runIncidentOperatorAction, RESOLVE_NOTE_REQUIRED, type IncidentOperatorActionDeps } from "./operator-route";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [e, w, l] = [console.error, console.warn, console.log]; console.error = () => {}; console.warn = () => {}; console.log = () => {};
  try { return await f(); } finally { console.error = e; console.warn = w; console.log = l; }
};

type Row = Record<string, unknown> & { id: string };
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : (a ?? null) === (b ?? null));

function makeClient() {
  const issues: Row[] = [];
  const occurrences: Row[] = [];
  const events: Row[] = [];
  const audits: Row[] = [];
  let n = 0;
  let clock = Date.parse("2026-11-04T10:00:00.000Z");
  const stamp = () => new Date((clock += 1000));
  const match = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => same(r[k], v));
  const syncIssue = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (data.incidentKey != null && data.resolved === false && issues.some((r) => r.incidentKey === data.incidentKey && r.resolved === false)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row: Row = { lifecycleState: null, acknowledgedAt: null, ...data, id: `i${++n}`, updatedAt: stamp() };
      issues.push(row);
      return row;
    },
    findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
      const hits = issues.filter((r) => match(r, where));
      void orderBy;
      return hits[hits.length - 1] ?? null;
    },
    findUnique: async ({ where }: { where: { id: string } }) => {
      const r = issues.find((x) => x.id === where.id);
      return r ? { ...r } : null;
    },
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => issues.filter((r) => (where ? match(r, where) : true)),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = issues.find((x) => x.id === where.id)!;
      Object.assign(r, data, { updatedAt: stamp() });
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hits = issues.filter((r) => match(r, where));
      hits.forEach((r) => Object.assign(r, data, { updatedAt: stamp() }));
      return { count: hits.length };
    },
  };
  const syncIssueOccurrence = { create: async ({ data }: { data: Record<string, unknown> }) => { const r = { ...data, id: `o${++n}` }; occurrences.push(r); return r; } };
  const syncIssueEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { const r = { ...data, id: `e${++n}` }; events.push(r); return r; } };
  const auditLog = { create: async ({ data }: { data: Record<string, unknown> }) => { const r = { ...data, id: `a${++n}` }; audits.push(r); return r; } };
  const client = {
    syncIssue, syncIssueOccurrence, syncIssueEvent, auditLog,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snap = issues.map((r) => ({ ...r }));
      const [ev, au] = [events.length, audits.length];
      try { return await fn({ syncIssue, syncIssueEvent, auditLog }); }
      catch (e) { issues.splice(0, issues.length, ...snap); events.splice(ev); audits.splice(au); throw e; }
    },
  };
  return {
    client, issues, events, audits, occurrences,
    incident: client as unknown as IncidentClient,
    op: client as unknown as OperatorTransitionClient,
  };
}

const fail = (item: string) => ({
  kind: "UPSERT_ERROR" as const, plaidItemId: item, plaidTransactionId: "tx1",
  detail: { stage: "transaction-persist", cursorBlocking: true },
});
const ACTOR = { userId: "op_1", via: "PLATFORM_GRANT" as const, area: "PLATFORM_OPS" };
const REASON = { code: "INCIDENT" as const, note: "checked the provider status page" };

async function main() {
  console.log("1. acknowledge — all three fields together, lifecycleState stays NULL (B9 constraint a)");
  {
    const k = makeClient();
    const o = (await recordIncidentObservation(fail("it1"), k.incident))!;
    const out = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "acknowledge" }, actor: ACTOR, reason: { code: "INCIDENT" } }, k.op);
    const row = k.issues.find((r) => r.id === o.incidentId)!;
    check("acknowledged: changed, ACTIVE → ACKNOWLEDGED (derived)", out.ok && out.changed && out.fromState === "ACTIVE" && out.toState === "ACKNOWLEDGED", out);
    check("acknowledgedAt + acknowledgedById + acknowledgedAuditId set TOGETHER (all-or-none CHECK)",
      row.acknowledgedAt instanceof Date && row.acknowledgedById === "op_1" && typeof row.acknowledgedAuditId === "string" && row.acknowledgedAuditId === (out.ok && out.changed ? out.auditId : null));
    check("lifecycleState is NOT written (stays NULL) and the row stays open", row.lifecycleState === null && row.resolved === false && row.resolvedAt == null);
    const ev = k.events.filter((e) => e.incidentId === row.id && e.actorKind === "OPERATOR");
    check("one OPERATOR STATE_CHANGED event: ACKNOWLEDGE, actor + audit id, ACTIVE → ACKNOWLEDGED",
      ev.length === 1 && ev[0].type === "STATE_CHANGED" && ev[0].actionCode === "ACKNOWLEDGE" && ev[0].actorId === "op_1"
      && ev[0].auditId === row.acknowledgedAuditId && ev[0].fromState === "ACTIVE" && ev[0].toState === "ACKNOWLEDGED", ev);
    const a = k.audits[0] as unknown as { action: string; performedByAdminId: string; metadata: Record<string, unknown> };
    check("one audit row: SYNC_INCIDENT_ACKNOWLEDGED, SYNC_INCIDENT target, reason recorded, no detail/customer",
      k.audits.length === 1 && a.action === "SYNC_INCIDENT_ACKNOWLEDGED" && a.performedByAdminId === "op_1"
      && JSON.stringify(a.metadata.target) === JSON.stringify({ kind: "SYNC_INCIDENT", id: row.id })
      && (a.metadata.reason as { code: string }).code === "INCIDENT" && !/transaction-persist|tx1|it1/.test(JSON.stringify(a.metadata)), a.metadata);

    const again = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "acknowledge" }, actor: { ...ACTOR, userId: "op_2" }, reason: { code: "INCIDENT" } }, k.op);
    check("idempotent: a second acknowledge changes nothing and writes no audit or event",
      again.ok && again.changed === false && k.audits.length === 1 && k.events.filter((e) => e.actorKind === "OPERATOR").length === 1 && row.acknowledgedById === "op_1");

    // Recurrence after acknowledge converges onto the SAME row; ownership is kept.
    const before = k.issues.length;
    const o2 = (await recordIncidentObservation(fail("it1"), k.incident))!;
    check("a failure after acknowledge converges on the same row; acknowledgement kept; state still NULL",
      o2.incidentId === row.id && o2.created === false && k.issues.length === before && row.acknowledgedById === "op_1" && row.lifecycleState === null);
  }

  console.log("\n2. manual resolve — RESOLVED + resolved, operator kind, reason code, typed evidence, one transaction");
  {
    const k = makeClient();
    const o = (await recordIncidentObservation(fail("it1"), k.incident))!;
    await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "acknowledge" }, actor: ACTOR, reason: { code: "INCIDENT" } }, k.op);
    const out = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "resolve", resolutionReasonCode: "OPERATOR_FIXED" }, actor: ACTOR, reason: REASON }, k.op);
    const row = k.issues.find((r) => r.id === o.incidentId)!;
    check("resolved: ACKNOWLEDGED → RESOLVED", out.ok && out.changed && out.fromState === "ACKNOWLEDGED" && out.toState === "RESOLVED", out);
    check("lifecycleState RESOLVED with resolved=true and resolvedAt (lifecycleState_resolved + resolved_state_reason CHECKs)",
      row.lifecycleState === "RESOLVED" && row.resolved === true && row.resolvedAt instanceof Date && row.resolutionReasonCode === "OPERATOR_FIXED");
    check("kind OPERATOR_RESOLVED with resolvedById + resolutionAuditId (the invariant)",
      row.resolutionKind === "OPERATOR_RESOLVED" && row.resolvedById === "op_1" && typeof row.resolutionAuditId === "string" && row.resolvingExecutionId === null
      && lifecycleViolation("condition", row as never) === null);
    const ev = row.resolutionEvidence as ResolutionEvidence;
    check("evidence: rule OPERATOR_RESOLVED_V1, no proof, operator {auditId, via, reasonCode} only",
      ev.rule === OPERATOR_RESOLVED_RULE && ev.proofCount === 0 && ev.proof.length === 0
      && JSON.stringify(ev.operator) === JSON.stringify({ auditId: row.resolutionAuditId, via: "PLATFORM_GRANT", reasonCode: "OPERATOR_FIXED" }), ev);
    check("evidence carries no note, no operator user id, no subject", !/provider status|op_1|it1|tx1/.test(JSON.stringify(ev)), ev);
    check("the archive copy keeps the operator record (typed reshaper)", JSON.stringify(reshapeStoredEvidence(ev)) === JSON.stringify(ev));
    check("the read digest accepts it and never claims proof", digestStoredEvidence(ev)?.mayAdvance === false && digestStoredEvidence(ev)?.rule === OPERATOR_RESOLVED_RULE);
    const resolveAudit = k.audits.find((a) => a.action === "SYNC_INCIDENT_RESOLVED") as { id: string; metadata: Record<string, unknown> } | undefined;
    check("the audit row carries the note, the code and the resolution reason; its id is on the row",
      !!resolveAudit && resolveAudit.id === row.resolutionAuditId && (resolveAudit.metadata.reason as { note: string }).note === REASON.note
      && resolveAudit.metadata.resolutionReasonCode === "OPERATOR_FIXED");
    const sc = k.events.filter((e) => e.incidentId === row.id && e.actionCode === "RESOLVE");
    check("one OPERATOR STATE_CHANGED → RESOLVED event with the audit id", sc.length === 1 && sc[0].type === "STATE_CHANGED" && sc[0].toState === "RESOLVED" && sc[0].auditId === row.resolutionAuditId);

    const twice = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "resolve", resolutionReasonCode: "OPERATOR_FIXED" }, actor: ACTOR, reason: REASON }, k.op);
    check("resolving a resolved incident is refused (ALREADY_RESOLVED), nothing written", !twice.ok && twice.code === "ALREADY_RESOLVED" && k.audits.length === 2);
    const ackClosed = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "acknowledge" }, actor: ACTOR, reason: REASON }, k.op);
    check("acknowledging a resolved incident is refused", !ackClosed.ok && ackClosed.code === "ALREADY_RESOLVED");

    console.log("\n3. reopen-by-recurrence — the next failure opens a NEW episode; the resolved row is never reopened (B9 constraint b)");
    const snapshot = JSON.stringify(row);
    const next = (await recordIncidentObservation(fail("it1"), k.incident))!;
    const fresh = k.issues.find((r) => r.id === next.incidentId)!;
    check("a NEW episode, linked backwards, openedBy RECURRENCE, lifecycleState NULL",
      next.created === true && fresh.id !== row.id && fresh.previousIncidentId === row.id && fresh.openedBy === "RECURRENCE" && fresh.lifecycleState === null && fresh.resolved === false);
    check("the operator-resolved row is untouched (still RESOLVED, resolved=true)", JSON.stringify(row) === snapshot && row.resolved === true);
    check("the new episode carries no acknowledgement (ownership does not carry across a closure)", fresh.acknowledgedAt == null && fresh.acknowledgedById == null);
  }

  console.log("\n4. CAS — a concurrent write between the read and the update refuses the transition and rolls back the audit");
  {
    const k = makeClient();
    const o = (await recordIncidentObservation(fail("it1"), k.incident))!;
    const real = k.client.syncIssue.findUnique;
    k.client.syncIssue.findUnique = async (a) => {
      const read = await real(a);
      // the racing observation: lastOccurredAt moves ⇒ updatedAt moves
      await k.client.syncIssue.update({ where: { id: o.incidentId }, data: { lastOccurredAt: new Date() } });
      return read;
    };
    const out = await quiet(() => applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "resolve", resolutionReasonCode: "OPERATOR_FIXED" }, actor: ACTOR, reason: REASON }, k.op));
    const row = k.issues.find((r) => r.id === o.incidentId)!;
    check("refused as CONFLICT", !out.ok && out.code === "CONFLICT", out);
    check("nothing persisted: row open, no audit row, no operator event", row.resolved === false && row.resolutionKind == null && k.audits.length === 0 && !k.events.some((e) => e.actorKind === "OPERATOR"));
    k.client.syncIssue.findUnique = real;
    const retry = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "resolve", resolutionReasonCode: "OPERATOR_FIXED" }, actor: ACTOR, reason: REASON }, k.op);
    check("…and a retry on the fresh state succeeds", retry.ok && retry.changed === true);
  }

  console.log("\n5. refusals — not found, evidence events, invalid codes, unsafe notes");
  {
    const k = makeClient();
    const nf = await applyOperatorTransition({ incidentId: "nope", transition: { action: "acknowledge" }, actor: ACTOR, reason: REASON }, k.op);
    check("unknown id ⇒ NOT_FOUND", !nf.ok && nf.code === "NOT_FOUND");
    const evt = (await recordIncidentObservation({ kind: "REMOVED_TOMBSTONE", plaidItemId: "it1", plaidTransactionId: "t9", detail: {} }, k.incident))!;
    const ne = await applyOperatorTransition({ incidentId: evt.incidentId, transition: { action: "acknowledge" }, actor: ACTOR, reason: REASON }, k.op);
    check("an evidence EVENT has no lifecycle ⇒ NOT_A_CONDITION", !ne.ok && ne.code === "NOT_A_CONDITION", ne);
    const o = (await recordIncidentObservation(fail("it2"), k.incident))!;
    const bad = await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "resolve", resolutionReasonCode: "BALANCE_OBSERVED" as never }, actor: ACTOR, reason: REASON }, k.op);
    check("a SYSTEM reason code is never accepted from an operator ⇒ INVALID", !bad.ok && bad.code === "INVALID");
    let threw = false;
    try { await applyOperatorTransition({ incidentId: o.incidentId, transition: { action: "acknowledge" }, actor: ACTOR, reason: { code: "INCIDENT", note: "mail someone@example.com" } }, k.op); }
    catch { threw = true; }
    check("an unsafe note throws inside the transaction and writes nothing", threw && k.audits.length === 0 && k.issues.find((r) => r.id === o.incidentId)!.acknowledgedAt == null);
  }

  console.log("\n6. the route runner — reason required, token-first, the module's rule decides");
  {
    check("acknowledge needs a reason", !parseIncidentActionBody("acknowledge", {}).ok && !parseIncidentActionBody("acknowledge", null).ok
      && parseIncidentActionBody("acknowledge", { reason: { code: "INCIDENT" } }).ok);
    const noNote = parseIncidentActionBody("resolve", { resolutionReasonCode: "OPERATOR_FIXED", reason: { code: "INCIDENT" } });
    check("resolve needs a note", !noNote.ok && noNote.error === RESOLVE_NOTE_REQUIRED);
    check("resolve needs a REGISTERED operator resolution code", !parseIncidentActionBody("resolve", { resolutionReasonCode: "SUBJECT_DELETED", reason: REASON }).ok
      && !parseIncidentActionBody("resolve", { resolutionReasonCode: "fixed", reason: REASON }).ok
      && parseIncidentActionBody("resolve", { resolutionReasonCode: "OPERATOR_FIXED", reason: REASON }).ok);
    check("a note over 280 characters is refused", !parseIncidentActionBody("acknowledge", { reason: { code: "INCIDENT", note: "x".repeat(281) } }).ok);

    const calls: string[] = [];
    const deps = (state: string, actions: string[], found = true): IncidentOperatorActionDeps => ({
      investigate: (async () => (found ? { verdict: { state, availableActions: actions } } : null)) as never,
      apply: (async (i: { transition: { action: string } }) => { calls.push(i.transition.action); return { ok: true, changed: true, auditId: "a", eventId: "e", fromState: "ACTIVE", toState: "X" }; }) as never,
    });
    const token = {} as never;
    const base = { incidentId: "i1", token, actor: ACTOR };
    const st = async (p: Promise<Response>) => { const r = await p; return { status: r.status, body: await r.json(), cache: r.headers.get("Cache-Control") }; };
    const noToken = await st(runIncidentOperatorAction({ ...base, token: null, action: "acknowledge", body: { reason: REASON } }, deps("active", ["acknowledge", "resolve"])));
    check("no incident tier ⇒ 403, no-store, nothing applied", noToken.status === 403 && noToken.cache === "no-store" && calls.length === 0);
    const bad = await st(runIncidentOperatorAction({ ...base, action: "acknowledge", body: {} }, deps("active", ["acknowledge"])));
    check("no reason ⇒ 400 before any read", bad.status === 400 && calls.length === 0);
    const missing = await st(runIncidentOperatorAction({ ...base, action: "acknowledge", body: { reason: REASON } }, deps("active", [], false)));
    check("not found through the module ⇒ 404", missing.status === 404 && calls.length === 0);
    const notOffered = await st(runIncidentOperatorAction({ ...base, action: "resolve", body: { resolutionReasonCode: "OPERATOR_FIXED", reason: REASON } }, deps("resolved", ["reopen"])));
    check("an action the module does not offer ⇒ 409 NOT_AVAILABLE, nothing applied", notOffered.status === 409 && notOffered.body.code === "NOT_AVAILABLE" && calls.length === 0);
    const reopen = await st(runIncidentOperatorAction({ ...base, action: "resolve", body: { resolutionReasonCode: "OPERATOR_FIXED", reason: REASON } }, deps("resolved", ["reopen", "resolve"].filter((x) => x === "reopen"))));
    check("…including a derived closure (connection removed: no actions)", reopen.status === 409 && calls.length === 0);
    const already = await st(runIncidentOperatorAction({ ...base, action: "acknowledge", body: { reason: REASON } }, deps("acknowledged", ["resolve"])));
    check("acknowledge on an acknowledged incident ⇒ 200 changed:false, nothing applied (idempotent)", already.status === 200 && already.body.changed === false && calls.length === 0);
    const ok = await st(runIncidentOperatorAction({ ...base, action: "resolve", body: { resolutionReasonCode: "OPERATOR_FIXED", reason: REASON } }, deps("stale-unverified", ["acknowledge", "resolve"])));
    check("an offered action is applied once ⇒ 200", ok.status === 200 && ok.body.changed === true && calls.join() === "resolve");
    const conflict = await st(runIncidentOperatorAction({ ...base, action: "acknowledge", body: { reason: REASON } }, {
      ...deps("active", ["acknowledge"]), apply: (async () => ({ ok: false, code: "CONFLICT" })) as never,
    }));
    check("a lost CAS ⇒ 409 CONFLICT", conflict.status === 409 && conflict.body.code === "CONFLICT");
  }

  if (failures > 0) { console.error(`\noperator-transition.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\noperator-transition.test: all passed.");
}

main();
