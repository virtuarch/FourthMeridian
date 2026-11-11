/**
 * lib/platform/incidents/customer-update/customer-update.test.ts  (Incident customer update, PR-C1)
 *
 * Owner yes; S2 ruling 09gg (c). Pure + injected-deps tests — no database:
 *   1. lint: every refusal class, near-misses allowed, "fixed" only with verified recovery, the 600 cap;
 *   2. the deterministic draft per remedy class (and every draft passes its own lint);
 *   3. send: flag off ⇒ refused, nothing read / audited / created;
 *   4. send: the order (lint ⇒ dedupe ⇒ audit ⇒ create), the audit carries no text, the recipient is the
 *      incident's own subject (never the client's), ledger rows tagged with the incident id;
 *   5. dedupe: second send in the episode refused; within 24 h of a reauth notice (created AND
 *      suppressed_duplicate) refused; older / non-notifying notices do not block;
 *   6. audit before send: createNotification throws ⇒ the approval exists, nothing is marked sent;
 *   7. tiers: an Ops token is refused; READ cannot send (route guard + grant rule);
 *   8. read model / preview / deliveries;
 *   9. static: the routes' guards, limiters and refusal recording.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/customer-update/customer-update.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- loose reads of JSON response bodies in assertions only */
import { readFileSync } from "node:fs";
import { UserRole } from "@prisma/client";
import { incidentAudienceFor, type CsToken, type OpsToken } from "../intelligence/audience";
import type { CsIncidentVerdict, IncidentInvestigation } from "../intelligence/types";
import { incidentDetailDTO } from "../investigation-dto";
import { hasPlatformAccess } from "@/lib/platform/policy";
import { AuditAction } from "@/lib/audit-actions";
import type { OperatorActionInput } from "@/lib/audit";
import { NOTIFICATION_REGISTRY } from "@/lib/notifications/registry";
import { INCIDENT_UPDATE_CLOSING, INCIDENT_UPDATE_OPENING, renderIncidentCustomerUpdate } from "@/lib/notifications/incident-customer-update";
import {
  DRAFTS, INCIDENT_UPDATE_PARAGRAPH_MAX, draftIncidentCustomerUpdate, lintIncidentCustomerUpdate, reauthNoticeState,
  type DraftClass, type EpisodeDeliveryFact, type LintCode, type ReauthNoticeFact,
} from "./core";
import {
  customerUpdatePreview, customerUpdateReadModel, customerUpdateSend, incidentDeliveries, paragraphHash,
  type CreateIncidentUpdateCtx, type CreateIncidentUpdateInput, type CustomerUpdateDeps,
} from "./service";
import { createNotification, tagLedgerRow, type CreateNotificationResult } from "@/lib/notifications/create";
import type { CommsDeliveryRow } from "@/lib/notifications/delivery/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
}

const NOW = new Date("2026-11-11T12:00:00.000Z");
const HOUR = 3_600_000;
const SUBJECT = "u_subject_0000000001";
const INCIDENT = "inc_cu_1";
const ITEM = "item_cu_1";

// ── fixtures ─────────────────────────────────────────────────────────────────

function verdict(o: Partial<CsIncidentVerdict> = {}): CsIncidentVerdict {
  return {
    id: INCIDENT, rowClass: "incident", state: "active", freshness: "current", closure: null, closureDerived: false,
    kind: "SYNC_FAILED", provider: "PLAID", domain: "BANKING", severity: "error", effectiveSeverity: "error",
    customerActionable: false, cursorBlocking: false, operation: null, label: "Sync failed", operationLabel: null,
    firstSeenAt: new Date(NOW.getTime() - 48 * HOUR).toISOString(), lastSeenAt: NOW.toISOString(), resolvedAt: null,
    occurrenceCount: 3, correlatedOccurrenceCount: 0, episodeKey: "key-1", duplicateOf: null,
    plaidItemId: ITEM, financialAccountId: null, subjectState: "LIVE", brokenNow: true, alertable: false, attentionPriority: 1,
    spread: { groupKey: "PLAID::BANKING::sync", spread: "isolated", affectedSubjects: 1 },
    recurrence: { generation: 1, previousIncidentId: null, relatedIncidentIds: [] },
    recovery: { proofCount: 0, mayAdvance: false, lastAttemptAt: null, lastSkipAt: null, evidenceKnown: true, evidenceBasis: "attempts" as never },
    causeStatus: null, causeCode: null, availableActions: [], subjectUserId: SUBJECT,
    ...o,
  } as CsIncidentVerdict;
}

function investigation(o: { verdict?: Partial<CsIncidentVerdict>; itemStatus?: string | null; code?: string | null; institution?: string | null } = {}): IncidentInvestigation<CsIncidentVerdict> {
  const code = o.code === undefined ? "ITEM_LOGIN_REQUIRED" : o.code;
  return {
    verdict: verdict(o.verdict),
    evidence: null, resolutionReasonCode: null,
    timeline: { source: "events", truncated: false, events: [] } as never,
    affected: { provider: "PLAID", institution: o.institution === undefined ? "Example Bank" : o.institution, itemCount: 1, accountCount: 1, subjectState: "LIVE", itemStatus: o.itemStatus === undefined ? "ERROR" : o.itemStatus },
    related: [], recurrences: [], recurrencesTruncated: false,
    archive: { archived: false, archivedAt: null, archiveDueAt: null, retainedUntil: null },
    providerError: { code, source: code ? "connection" : null, unrecognised: false },
    attempts: null,
  };
}

const csToken = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "WRITE" } }) as CsToken;
const opsToken = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "WRITE" } }) as OpsToken;
const ACTOR: OperatorActionInput["actor"] = { userId: "op_cs_1", via: "PLATFORM_GRANT", area: "CUSTOMER_SUCCESS" };

interface World {
  deps: CustomerUpdateDeps;
  log: string[];
  audits: OperatorActionInput[];
  creates: Array<{ input: CreateIncidentUpdateInput; ctx: CreateIncidentUpdateCtx }>;
  deliveryQueries: Array<{ incidentId: string; recipientUserId: string; since: Date }>;
}

function world(o: {
  enabled?: boolean;
  inv?: IncidentInvestigation<CsIncidentVerdict> | null;
  deliveries?: EpisodeDeliveryFact[];
  notices?: ReauthNoticeFact[];
  active?: boolean;
  createResult?: CreateNotificationResult | "throw";
  auditThrows?: boolean;
  deliveriesThrow?: boolean;
} = {}): World {
  const log: string[] = [];
  const audits: OperatorActionInput[] = [];
  const creates: World["creates"] = [];
  const deliveryQueries: World["deliveryQueries"] = [];
  const deps: CustomerUpdateDeps = {
    now: () => NOW,
    sendEnabled: () => o.enabled ?? true,
    investigate: async (_t, id) => { log.push("investigate"); return o.inv === undefined ? (id === INCIDENT ? investigation() : null) : o.inv; },
    readDeliveries: async (q) => { log.push("readDeliveries"); deliveryQueries.push(q); if (o.deliveriesThrow) throw new Error("db down"); return o.deliveries ?? []; },
    readReauthNotices: async () => { log.push("readReauthNotices"); return o.notices ?? []; },
    recipientActive: async () => { log.push("recipientActive"); return o.active ?? true; },
    privRef: (id) => `ref_${id.length}`,
    recordApproval: async (input) => { log.push("audit"); if (o.auditThrows) throw new Error("audit down"); audits.push(input); return { id: "audit_1" }; },
    createNotification: async (input, ctx) => {
      log.push("create");
      if (o.createResult === "throw") throw new Error("notification store down");
      creates.push({ input, ctx });
      return o.createResult ?? { status: "created", id: "n_1" };
    },
  };
  return { deps, log, audits, creates, deliveryQueries };
}

const reason = { code: "INCIDENT", note: "Customer asked what is going on" };
const good = DRAFTS["customer-reconnect"];
const send = (w: World, body: unknown, token: CsToken | OpsToken | null = csToken, id = INCIDENT) =>
  customerUpdateSend(token, id, body, { actor: ACTOR, ipAddress: "203.0.113.9", userAgent: "test" }, w.deps);
const codes = (text: string, verifiedRecovery = false, institution: string | null = "Example Bank") =>
  lintIncidentCustomerUpdate(text, { verifiedRecovery, institution }).codes;
const has = (text: string, code: LintCode, verifiedRecovery = false, institution: string | null = "Example Bank") =>
  codes(text, verifiedRecovery, institution).includes(code);

async function main(): Promise<void> {
  // ── 1. lint ────────────────────────────────────────────────────────────────
  console.log("1. lint — each refusal class, near-misses allowed");
  {
    check("EMPTY", has("   ", "EMPTY"));
    check("LINE_BREAK — one paragraph only", has("First line.\nSecond line.", "LINE_BREAK") && has("a\r\nb", "LINE_BREAK"));
    check("a trailing newline from a text box is not a second paragraph", !has("We are looking into it.\n", "LINE_BREAK"));
    check("MARKUP", has("Please <b>reconnect</b>", "MARKUP") && has("Hello {{firstName}}", "MARKUP"));
    for (const t of ["Go to https://evil.example now", "visit example.com", "write to help@example.io", "call 555-123-4567", "www.example.org", "evil dot com"]) {
      check(`LINK: ${t}`, has(t, "LINK"), codes(t));
    }
    for (const t of ["You were charged $40", "about 12 accounts", "a 5% fee", "ten percent more", "fifty dollars", "the USD balance", "€ amounts"]) {
      check(`FIGURE: ${t}`, has(t, "FIGURE"), codes(t));
    }
    for (const t of ["your account number", "the card ending in that card", "the last four of your card", "the routing details", "the error ITEM_LOGIN_REQUIRED",
      "your Example Bank connection", "your EXAMPLE BANK login", "item id ckabcdefghijklmnopqrstu", "your IBAN"]) {
      check(`IDENTIFIER: ${t}`, has(t, "IDENTIFIER"), codes(t));
    }
    for (const t of ["We recommend moving your money", "you should invest elsewhere", "this is guaranteed", "consult a lawyer", "buy more shares", "earn more interest"]) {
      check(`ADVICE: ${t}`, has(t, "ADVICE"), codes(t));
    }
    for (const t of ["We fixed the problem", "it is resolved", "access has been restored", "we will fix this soon", "everything is back to normal", "it is working again", "we are resolving it"]) {
      check(`PROMISE without verified recovery: ${t}`, has(t, "PROMISE"), codes(t));
      check(`…allowed WITH verified recovery: ${t}`, !has(t, "PROMISE", true), codes(t, true));
    }
    const nearMisses = [
      "One of your connections needs attention.", "Your Wi-Fi is not involved.", "This is not a test fixture.", "The prefix in the name is fine.",
      "We are working on a resolution with our data provider.", "Restoration of the feed is in progress.", "Your account is safe.",
      "Please sign in again.", "We will keep trying automatically.", "Your history is kept.", "Our team is looking into it.",
      "Your bank connection needs you to sign in again.",
    ];
    for (const t of nearMisses) check(`near-miss allowed: "${t}"`, lintIncidentCustomerUpdate(t, { verifiedRecovery: false, institution: "Example Bank" }).ok, codes(t));
    check("another institution's name is not this incident's identifier (the lexicon is the guard)", !has("Institution B", "IDENTIFIER", false, "Example Bank"));
    check("an institution name shorter than 3 characters is never matched", !has("an update", "IDENTIFIER", false, "an"));
    const at600 = ("Our team is looking into it. ".repeat(30)).slice(0, INCIDENT_UPDATE_PARAGRAPH_MAX - 1) + "x";
    check("the cap is 600 characters: exactly 600 passes", at600.length === 600 && !has(at600, "TOO_LONG"), at600.length);
    check("…601 is TOO_LONG", has(at600 + "y", "TOO_LONG"));
    const r = lintIncidentCustomerUpdate("Visit https://evil.example/steal for $777", { verifiedRecovery: false });
    check("the result carries codes and lengths only — never the text", !JSON.stringify(r).includes("evil") && !JSON.stringify(r).includes("777") && r.codes.join() === "LINK,FIGURE", r);
  }

  // ── 2. the deterministic draft ─────────────────────────────────────────────
  console.log("\n2. draft — deterministic by remedy class, no AI");
  {
    const dto = (inv: IncidentInvestigation<CsIncidentVerdict>) => incidentDetailDTO(inv, "cs", NOW);
    const cases: Array<[string, IncidentInvestigation<CsIncidentVerdict>, DraftClass]> = [
      ["ITEM_LOGIN_REQUIRED / ERROR ⇒ customer-reconnect", investigation({ code: "ITEM_LOGIN_REQUIRED", itemStatus: "ERROR" }), "customer-reconnect"],
      ["NEEDS_REAUTH ⇒ customer-reconnect", investigation({ code: null, itemStatus: "NEEDS_REAUTH" }), "customer-reconnect"],
      ["USER_PERMISSION_REVOKED ⇒ customer-re-add", investigation({ code: "USER_PERMISSION_REVOKED", itemStatus: "ERROR" }), "customer-re-add"],
      ["INSTITUTION_DOWN ⇒ server-retry", investigation({ code: "INSTITUTION_DOWN", itemStatus: "ERROR" }), "server-retry"],
      ["no verified code ⇒ investigate", investigation({ code: "ITEM_LOCKED", itemStatus: "ERROR" }), "investigate"],
      ["closed by an operator (not verified) ⇒ general", investigation({ verdict: { state: "resolved", closure: "operator", resolvedAt: NOW.toISOString() } }), "general"],
      ["closed, connection removed ⇒ general", investigation({ verdict: { state: "resolved", closure: "connection-removed", resolvedAt: NOW.toISOString() } }), "general"],
      ["closed AUTOMATIC_RECOVERY with evidence ⇒ recovered", investigation({ verdict: { state: "resolved", closure: "recovered", resolvedAt: NOW.toISOString() } }), "recovered"],
    ];
    for (const [name, inv, want] of cases) {
      const a = draftIncidentCustomerUpdate(dto(inv));
      const b = draftIncidentCustomerUpdate(dto(inv));
      check(name, a.draftClass === want && a.paragraph === DRAFTS[want], a.draftClass);
      check(`…deterministic (same input ⇒ same paragraph): ${want}`, a.paragraph === b.paragraph && a.draftClass === b.draftClass);
      check(`…verifiedRecovery only for the recovered class: ${want}`, a.verifiedRecovery === (want === "recovered"));
    }
    for (const k of Object.keys(DRAFTS) as DraftClass[]) {
      const r = lintIncidentCustomerUpdate(DRAFTS[k], { verifiedRecovery: k === "recovered", institution: "Example Bank" });
      check(`the ${k} draft passes its own lint`, r.ok && DRAFTS[k].length <= INCIDENT_UPDATE_PARAGRAPH_MAX, r.codes);
    }
    check("the recovered copy is refused without verified recovery (PROMISE)", has(DRAFTS.recovered, "PROMISE"));
    const src = readFileSync("lib/platform/incidents/customer-update/core.ts", "utf8");
    check("the draft module calls no model (no AI import)", !/@\/lib\/ai|openai|anthropic|lib\/platform\/intelligence\/ai/i.test(src));
  }

  // ── 3. flag off ────────────────────────────────────────────────────────────
  console.log("\n3. INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED off ⇒ the send is refused, nothing happens");
  {
    const w = world({ enabled: false });
    const r = await send(w, { paragraph: good, reason });
    check("404 NOT_AVAILABLE, recorded as a SEND_DISABLED refusal", r.status === 404 && r.body.code === "NOT_AVAILABLE" && r.refusal === "SEND_DISABLED", r);
    check("nothing read, audited or created", w.log.length === 0 && w.audits.length === 0 && w.creates.length === 0, w.log);
    const env = readFileSync("lib/env.ts", "utf8");
    check("the flag is strict \"true\" (absent / anything else ⇒ OFF)",
      /get isIncidentCustomerMessageSendEnabled\(\) \{ return _e\.INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED === "true"; \}/.test(env)
      && /INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED: process\.env\.INCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED,/.test(env));
    check(".env.example documents the flag empty (default OFF)", /\nINCIDENT_CUSTOMER_MESSAGE_SEND_ENABLED=\n/.test(readFileSync(".env.example", "utf8")));
    check("production deps read the flag from lib/env (never a constant ON)",
      /sendEnabled: \(\) => env\.isIncidentCustomerMessageSendEnabled/.test(readFileSync("lib/platform/incidents/customer-update/deps.ts", "utf8")));
    const rm = await customerUpdateReadModel(csToken, INCIDENT, world({ enabled: false }).deps);
    check("the read model says sendEnabled:false and blockedBy SEND_DISABLED (the drawer hides the control)",
      rm.status === 200 && rm.body.sendEnabled === false && (rm.body.blockedBy as string[]).includes("SEND_DISABLED") && rm.body.canSend === false, rm.body);
  }

  // ── 4. the happy path: order, audit content, recipient ─────────────────────
  console.log("\n4. send — lint ⇒ dedupe ⇒ audit ⇒ create; the recipient is the incident's subject");
  {
    const w = world();
    const r = await send(w, { paragraph: `  ${good}  `, reason });
    check("200 sent", r.status === 200 && r.body.outcome === "sent" && r.body.sent === true && r.refusal === null, r);
    const ia = w.log.indexOf("audit"), ic = w.log.indexOf("create");
    check("the dedupe reads run before the audit, and the audit before the create",
      w.log.indexOf("readDeliveries") < ia && w.log.indexOf("readReauthNotices") < ia && ia >= 0 && ia < ic, w.log);
    const a = w.audits[0];
    check("audit: INCIDENT_CUSTOMER_UPDATE_APPROVED, target the incident, reason required + carried, SUCCESS",
      a?.action === AuditAction.INCIDENT_CUSTOMER_UPDATE_APPROVED && a.target.kind === "SYNC_INCIDENT" && a.target.id === INCIDENT
        && a.reason?.code === "INCIDENT" && a.result === "SUCCESS" && a.actor.area === "CUSTOMER_SUCCESS", a);
    const aJson = JSON.stringify(a);
    check("audit: NO message text — length + hash only", !aJson.includes("sign in again") && !aJson.includes(good.slice(0, 30))
      && a?.detail?.paragraphLength === good.length && a?.detail?.paragraphHash === paragraphHash(good) && a?.detail?.edited === false, a?.detail);
    check("audit: the customer only as a PRIV-ref, never the raw id", !aJson.includes(SUBJECT) && a?.detail?.recipientRef === `ref_${SUBJECT.length}`, a?.detail);
    const c = w.creates[0];
    check("create: INCIDENT_CUSTOMER_UPDATE for the incident's OWN subject",
      c?.input.type === "INCIDENT_CUSTOMER_UPDATE" && c.input.userId === SUBJECT && c.input.data.incidentId === INCIDENT, c?.input);
    check("create: the stored paragraph is the trimmed, linted one", c?.input.data.paragraph === good);
    check("create: in-app only, ledger rows tagged with the incident id, the Notification carries the approval's audit id",
      c?.ctx.inAppOnly === true && c.ctx.ledgerTag.incidentId === INCIDENT && c.input.auditLogId === "audit_1", c);
    check("the delivery read is bounded by the subject and the incident window first",
      w.deliveryQueries[0]?.recipientUserId === SUBJECT && w.deliveryQueries[0]?.incidentId === INCIDENT
        && w.deliveryQueries[0]?.since.toISOString() === new Date(NOW.getTime() - 48 * HOUR).toISOString(), w.deliveryQueries[0]);

    const edited = world();
    const er = await send(edited, { paragraph: "Our team is looking into the problem with your connection. You don't need to do anything.", reason });
    check("an edited paragraph is sent and audited as edited", er.status === 200 && edited.audits[0]?.detail?.edited === true);

    for (const [name, body] of [
      ["a userId in the body", { paragraph: good, reason, userId: "u_attacker" }],
      ["a recipient in the body", { paragraph: good, reason, recipient: "victim@example.com" }],
      ["a recipientUserId in the body", { paragraph: good, reason, recipientUserId: "u_attacker" }],
    ] as const) {
      const wx = world();
      const rx = await send(wx, body);
      check(`the recipient is never taken from the client: ${name} ⇒ 400, nothing audited or created`,
        rx.status === 400 && rx.refusal === "VALIDATION" && wx.audits.length === 0 && wx.creates.length === 0, rx);
    }
    const noReason = world();
    const nr = await send(noReason, { paragraph: good });
    check("no reason ⇒ 400 (reason required), nothing audited or created", nr.status === 400 && noReason.audits.length === 0 && noReason.creates.length === 0);
    const lintFail = world();
    const lf = await send(lintFail, { paragraph: "We fixed it, see https://example.com", reason });
    check("a failing lint ⇒ 422 LINT_FAILED with codes, before any dedupe read, audit or create",
      lf.status === 422 && lf.refusal === "LINT_FAILED" && JSON.stringify((lf.body.lint as { codes: string[] }).codes) === JSON.stringify(["LINK", "PROMISE"])
        && !lintFail.log.includes("readDeliveries") && lintFail.audits.length === 0 && lintFail.creates.length === 0, lf.body);
    const institution = world();
    const ir = await send(institution, { paragraph: "Your Example Bank connection needs you to sign in again.", reason });
    check("the incident's own institution name is refused (IDENTIFIER)", ir.status === 422 && (ir.body.lint as { codes: string[] }).codes.includes("IDENTIFIER"));
    const fixedOk = world({ inv: investigation({ verdict: { state: "resolved", closure: "recovered", resolvedAt: NOW.toISOString() } }) });
    const fo = await send(fixedOk, { paragraph: DRAFTS.recovered, reason });
    check("\"resolved\" is sendable when recovery is verified", fo.status === 200 && fixedOk.creates.length === 1, fo);
  }

  // ── 5. dedupe ──────────────────────────────────────────────────────────────
  console.log("\n5. dedupe — one per episode; none within 24 h of a reauth notice");
  {
    const accepted: EpisodeDeliveryFact = { channel: "IN_APP", status: "ACCEPTED", reason: null, errorCode: null, attempt: 1, mode: "LIVE", createdAt: new Date(NOW.getTime() - HOUR), acceptedAt: new Date(NOW.getTime() - HOUR) };
    const second = world({ deliveries: [accepted] });
    const r2 = await send(second, { paragraph: good, reason });
    check("a second send in the episode ⇒ 409 ALREADY_SENT, nothing audited or created",
      r2.status === 409 && r2.body.code === "ALREADY_SENT" && r2.refusal === "ALREADY_SENT" && second.audits.length === 0 && second.creates.length === 0, r2);
    const failedOnly = world({ deliveries: [{ ...accepted, status: "FAILED", errorCode: "STORE", acceptedAt: null }, { ...accepted, status: "SUPPRESSED", reason: "PREFERENCE_OFF", acceptedAt: null }] });
    const rf = await send(failedOnly, { paragraph: good, reason });
    check("a FAILED or preference-suppressed attempt is not 'sent' (the next approval may send)", rf.status === 200 && failedOnly.creates.length === 1, rf);
    const testRow = world({ deliveries: [{ ...accepted, mode: "TEST" }] });
    check("a TEST-mode row is not a sent update", (await send(testRow, { paragraph: good, reason })).status === 200);
    const raced = world({ createResult: { status: "suppressed" } });
    const rr = await send(raced, { paragraph: good, reason });
    check("the ':once' key wins a race: suppressed ⇒ 409 ALREADY_SENT (approval recorded, not sent)",
      rr.status === 409 && rr.body.code === "ALREADY_SENT" && rr.body.sent === false && rr.body.approvalRecorded === true);

    for (const outcome of ["created", "suppressed_duplicate"]) {
      const w = world({ notices: [{ outcome, at: new Date(NOW.getTime() - 3 * HOUR) }] });
      const r = await send(w, { paragraph: good, reason });
      check(`a reauth notice (${outcome}) 3 h ago ⇒ 409 REAUTH_NOTICE_RECENT with the notice's outcome and time; nothing audited or created`,
        r.status === 409 && r.body.code === "REAUTH_NOTICE_RECENT" && r.refusal === "REAUTH_NOTICE_RECENT"
          && (r.body.reauthNotice as { outcome: string }).outcome === outcome && w.audits.length === 0 && w.creates.length === 0, r.body);
    }
    const old = world({ notices: [{ outcome: "created", at: new Date(NOW.getTime() - 25 * HOUR) }] });
    check("a notice 25 h ago does not block", (await send(old, { paragraph: good, reason })).status === 200);
    for (const outcome of ["marked_not_notified", "no_change"]) {
      const w = world({ notices: [{ outcome, at: new Date(NOW.getTime() - HOUR) }] });
      check(`a request-reauth that sent no notice (${outcome}) does not block`, (await send(w, { paragraph: good, reason })).status === 200);
    }
    const s = reauthNoticeState([
      { outcome: "no_change", at: new Date(NOW.getTime() - HOUR) },
      { outcome: "created", at: new Date(NOW.getTime() - 5 * HOUR) },
      { outcome: "created", at: new Date(NOW.getTime() - 30 * HOUR) },
    ], NOW);
    check("reauthNoticeState: the newest BLOCKING notice wins over a newer non-blocking one; quietUntil = at + 24 h",
      s?.outcome === "created" && s.blocksSend && s.at === new Date(NOW.getTime() - 5 * HOUR).toISOString()
        && s.quietUntil === new Date(NOW.getTime() + 19 * HOUR).toISOString(), s);
    check("reauthNoticeState: nothing in 24 h ⇒ null", reauthNoticeState([{ outcome: "created", at: new Date(NOW.getTime() - 30 * HOUR) }], NOW) === null);
    const unreadable = world({ deliveriesThrow: true });
    const ur = await send(unreadable, { paragraph: good, reason });
    check("an unreadable dedupe fact refuses (fail closed): 500, nothing audited or created", ur.status === 500 && unreadable.audits.length === 0 && unreadable.creates.length === 0);
  }

  // ── 6. audit before send ───────────────────────────────────────────────────
  console.log("\n6. the audit is written BEFORE the send");
  {
    const w = world({ createResult: "throw" });
    const r = await send(w, { paragraph: good, reason });
    check("createNotification throws ⇒ 502 SEND_FAILED; the approval EXISTS; nothing is marked sent",
      r.status === 502 && r.body.code === "SEND_FAILED" && r.body.approvalRecorded === true && r.body.sent === false
        && w.audits.length === 1 && w.creates.length === 0, r);
    const e = world({ createResult: { status: "error", error: "x" } });
    const re = await send(e, { paragraph: good, reason });
    check("createNotification error ⇒ 502, approval recorded, not sent", re.status === 502 && re.body.sent === false && e.audits.length === 1);
    const a = world({ auditThrows: true });
    const ra = await send(a, { paragraph: good, reason });
    check("the audit fails ⇒ 500 AUDIT_FAILED and NOTHING is created", ra.status === 500 && ra.body.code === "AUDIT_FAILED" && !a.log.includes("create"), a.log);
    const skipped = world({ createResult: { status: "skipped" } });
    const rs = await send(skipped, { paragraph: good, reason });
    check("the customer's FINANCIAL in-app preference is off ⇒ 200 not_delivered_preference, sent:false", rs.status === 200 && rs.body.outcome === "not_delivered_preference" && rs.body.sent === false);
  }

  // ── 7. tiers and recipients ────────────────────────────────────────────────
  console.log("\n7. tiers — Customer Success only; READ cannot send");
  {
    const w = world();
    const r = await send(w, { paragraph: good, reason }, opsToken);
    check("a Platform Ops token ⇒ 403, the incident is never read, nothing audited or created",
      r.status === 403 && r.refusal === "FORBIDDEN" && !w.log.includes("investigate") && w.creates.length === 0, r);
    const wn = world();
    check("no token ⇒ 403", (await send(wn, { paragraph: good, reason }, null)).status === 403 && wn.creates.length === 0);
    for (const fn of [customerUpdateReadModel, incidentDeliveries]) {
      const wr = world();
      check(`${fn.name}: an Ops token ⇒ 403`, (await fn(opsToken, INCIDENT, wr.deps)).status === 403 && !wr.log.includes("investigate"));
    }
    check("preview: an Ops token ⇒ 403", (await customerUpdatePreview(opsToken, INCIDENT, { paragraph: good }, world().deps)).status === 403);
    const g = (area: "CUSTOMER_SUCCESS" | "PLATFORM_OPS", level: "READ" | "WRITE" | "CONTROL") => [{ area, level, status: "ACTIVE" as const }];
    check("grant rule: CUSTOMER_SUCCESS READ does NOT satisfy the send guard (CUSTOMER_SUCCESS WRITE)", !hasPlatformAccess("CUSTOMER_SUCCESS", "WRITE", g("CUSTOMER_SUCCESS", "READ")));
    check("grant rule: PLATFORM_OPS WRITE / CONTROL does NOT satisfy it", !hasPlatformAccess("CUSTOMER_SUCCESS", "WRITE", g("PLATFORM_OPS", "WRITE")) && !hasPlatformAccess("CUSTOMER_SUCCESS", "WRITE", g("PLATFORM_OPS", "CONTROL")));
    check("grant rule: CUSTOMER_SUCCESS WRITE does", hasPlatformAccess("CUSTOMER_SUCCESS", "WRITE", g("CUSTOMER_SUCCESS", "WRITE")));

    const noSubject = world({ inv: investigation({ verdict: { subjectUserId: null } }) });
    const ns = await send(noSubject, { paragraph: good, reason });
    check("an unattributed incident ⇒ 409 NO_RECIPIENT, nothing created", ns.status === 409 && ns.refusal === "NO_RECIPIENT" && noSubject.creates.length === 0);
    const inactive = world({ active: false });
    const ia = await send(inactive, { paragraph: good, reason });
    check("a deactivated / deleting customer ⇒ 409 NO_RECIPIENT before the audit", ia.status === 409 && inactive.audits.length === 0 && inactive.creates.length === 0);
    const dup = world({ inv: investigation({ verdict: { duplicateOf: "inc_newer" } }) });
    check("a folded legacy duplicate row ⇒ 409 NOT_ELIGIBLE", (await send(dup, { paragraph: good, reason })).status === 409 && dup.creates.length === 0);
    const evt = world({ inv: investigation({ verdict: { rowClass: "evidence" as never } }) });
    check("an evidence (non-incident) row ⇒ 409 NOT_ELIGIBLE", (await send(evt, { paragraph: good, reason })).status === 409 && evt.creates.length === 0);
    const missing = world();
    check("an unknown incident id ⇒ 404", (await send(missing, { paragraph: good, reason }, csToken, "inc_unknown")).status === 404 && missing.creates.length === 0);
    check("a malformed incident id ⇒ 404 without a read", (await send(world(), { paragraph: good, reason }, csToken, "../etc")).status === 404);

    const hashW = world();
    const stale = await send(hashW, { paragraph: good, reason, expectedDraftHash: "0".repeat(64) });
    check("expectedDraftHash that no longer matches the draft ⇒ 409 DRAFT_CHANGED, nothing audited", stale.status === 409 && stale.body.code === "DRAFT_CHANGED" && hashW.audits.length === 0);
    const okHash = world();
    check("the read model's draftHash is accepted", (await send(okHash, { paragraph: good, reason, expectedDraftHash: paragraphHash(good) })).status === 200);
    check("a malformed expectedDraftHash ⇒ 400", (await send(world(), { paragraph: good, reason, expectedDraftHash: "abc" })).status === 400);
  }

  // ── 8. read model / preview / deliveries ───────────────────────────────────
  console.log("\n8. read model, preview, deliveries");
  {
    const notice = { outcome: "suppressed_duplicate", at: new Date(NOW.getTime() - 2 * HOUR) };
    const rm = await customerUpdateReadModel(csToken, INCIDENT, world({ notices: [notice] }).deps);
    const b = rm.body as Record<string, any>;
    check("read model: the draft, its class and hash, and its lint", rm.status === 200 && b.draft.paragraph === good && b.draft.draftClass === "customer-reconnect"
      && b.draft.draftHash === paragraphHash(good) && b.lint.ok === true, b.draft);
    check("read model: the reauth notice's outcome and time, and that it blocks", b.dedupe.reauthNotice?.outcome === "suppressed_duplicate"
      && b.dedupe.reauthNotice.at === notice.at.toISOString() && b.dedupe.reauthNotice.blocksSend === true
      && b.blockedBy.includes("REAUTH_NOTICE_RECENT") && b.canSend === false, b.dedupe);
    check("read model: sendEnabled true when the flag is on; the fixed template is exposed", b.sendEnabled === true && b.template.opening === INCIDENT_UPDATE_OPENING && b.template.paragraphMax === 600);
    check("read model: the recipient is a boolean, never an id", b.recipient.attributed === true && !JSON.stringify(b).includes(SUBJECT));
    const sentRm = await customerUpdateReadModel(csToken, INCIDENT, world({ deliveries: [{ channel: "IN_APP", status: "ACCEPTED", reason: null, errorCode: null, attempt: 1, mode: "LIVE", createdAt: NOW, acceptedAt: NOW }] }).deps);
    check("read model: an episode already sent shows sent + sentAt and blocks", (sentRm.body as any).dedupe.episode.sent === true && (sentRm.body as any).blockedBy.includes("ALREADY_SENT"));

    const pw = world();
    const pv = await customerUpdatePreview(csToken, INCIDENT, { paragraph: good }, pw.deps);
    const msg = (pv.body as any).message;
    check("preview: the full message = fixed opening + the paragraph + fixed closing (the registry render)",
      pv.status === 200 && msg.body.startsWith(INCIDENT_UPDATE_OPENING) && msg.body.includes(good) && msg.body.endsWith(INCIDENT_UPDATE_CLOSING)
        && JSON.stringify(msg) === JSON.stringify(NOTIFICATION_REGISTRY.INCIDENT_CUSTOMER_UPDATE.render({ incidentId: INCIDENT, paragraph: good })), msg);
    check("preview: never audits or creates", pw.audits.length === 0 && pw.creates.length === 0 && !pw.log.includes("create") && !pw.log.includes("audit"));
    const pf = await customerUpdatePreview(csToken, INCIDENT, { paragraph: "Call 555-123-4567" }, world().deps);
    check("preview: a failing paragraph ⇒ 422 LINT_FAILED (no message rendered)", pf.status === 422 && pf.refusal === "LINT_FAILED" && !("message" in pf.body));
    check("preview: any other body field ⇒ 400", (await customerUpdatePreview(csToken, INCIDENT, { paragraph: good, userId: "x" }, world().deps)).status === 400);
    check("preview works with the send flag off (it never sends)", (await customerUpdatePreview(csToken, INCIDENT, { paragraph: good }, world({ enabled: false }).deps)).status === 200);
    check("render({}) is the frame alone (render totality)", renderIncidentCustomerUpdate({}).body === `${INCIDENT_UPDATE_OPENING}\n\n${INCIDENT_UPDATE_CLOSING}`);
    check("render re-bounds untrusted data (whitespace folded, capped)",
      renderIncidentCustomerUpdate({ paragraph: "a\n\nb" }).body.includes("\n\na b\n\n") && renderIncidentCustomerUpdate({ paragraph: "x".repeat(900) }).body.includes("x".repeat(600) + "\n\n"));

    const dw = world({ deliveries: [{ channel: "IN_APP", status: "ACCEPTED", reason: null, errorCode: null, attempt: 1, mode: "LIVE", createdAt: NOW, acceptedAt: NOW }] });
    const dv = await incidentDeliveries(csToken, INCIDENT, dw.deps);
    const items = (dv.body as any).items as Array<Record<string, unknown>>;
    check("deliveries: codes and status only", dv.status === 200 && items.length === 1
      && Object.keys(items[0]).sort().join() === "acceptedAt,attempt,channel,createdAt,errorCode,mode,reason,status" && (dv.body as any).episode.sent === true, items);
    const dn = world({ inv: investigation({ verdict: { subjectUserId: null } }) });
    check("deliveries: an unattributed incident reads nothing (no subject to bound the ledger read)",
      (await incidentDeliveries(csToken, INCIDENT, dn.deps)).status === 200 && !dn.log.includes("readDeliveries"));
  }

  // ── 8b. the real chokepoint: ledger rows carry the incident id; no email leg ─
  console.log("\n8b. createNotification — in-app only, every ledger row tagged with the incident id");
  {
    const rows: CommsDeliveryRow[] = [];
    const notifications: unknown[] = [];
    let emailCalls = 0;
    const client = {
      user: { findUnique: async () => ({ email: "customer@example.invalid" }) },
      notificationDelivery: { create: async () => ({ id: "nd_1" }) },
      notification: {
        create: async (args: { data: unknown }) => { notifications.push(args.data); return { id: "n_real_1" }; },
        findUnique: async () => null,
        update: async () => ({ id: "x" }),
      },
    };
    const res = await createNotification(
      { type: "INCIDENT_CUSTOMER_UPDATE", userId: SUBJECT, data: { incidentId: INCIDENT, paragraph: good }, auditLogId: "audit_1" },
      {
        client: client as never,
        // The customer opted IN to FINANCIAL email: the type still never emails (EMAIL excluded).
        prefClient: { notificationPreference: { findMany: async () => [{ category: "FINANCIAL", channel: "EMAIL", enabled: true }] } } as never,
        emailAdapter: { channel: "EMAIL", deliver: async () => { emailCalls++; return { status: "sent", provider: "test" }; } } as never,
        ledger: async (row) => { rows.push(row); },
        content: null,
        inAppOnly: true,
        ledgerTag: { incidentId: INCIDENT },
      },
    );
    check("created; the stored row is the fixed frame around the paragraph, with the approval's audit id",
      res.status === "created" && JSON.stringify(notifications[0]).includes(INCIDENT_UPDATE_OPENING.slice(0, 20)) && (notifications[0] as { auditLogId: string }).auditLogId === "audit_1"
        && (notifications[0] as { dedupeKey: string }).dedupeKey === `INCIDENT_CUSTOMER_UPDATE:incident:${INCIDENT}:once`, notifications[0]);
    check("no email is sent, whatever the preference", emailCalls === 0);
    check("every ledger row is IN_APP and carries incidentId", rows.length === 1 && rows.every((r) => r.channel === "IN_APP" && r.incidentId === INCIDENT && r.status === "ACCEPTED"), rows);
    check("tagLedgerRow drops a non-id-shaped incident id", tagLedgerRow(rows[0], { incidentId: "bad id;" }).incidentId === INCIDENT
      && tagLedgerRow({ ...rows[0], incidentId: undefined }, { incidentId: "../x" }).incidentId === undefined);
  }

  // ── 9. static: routes, registry, audit registration ────────────────────────
  console.log("\n9. static — routes, registry, audit registration");
  {
    const strip = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const base = "app/api/platform/customer-success/incidents/[id]";
    const sendR = strip(`${base}/customer-update/send/route.ts`);
    const prevR = strip(`${base}/customer-update/preview/route.ts`);
    const readR = strip(`${base}/customer-update/route.ts`);
    const delR = strip(`${base}/deliveries/route.ts`);
    for (const [name, s] of [["send", sendR], ["preview", prevR]] as const) {
      check(`${name}: POST only, guarded by exactly requireFreshPlatformAccess("CUSTOMER_SUCCESS", "WRITE")`,
        /export async function POST\(/.test(s) && !/export async function (GET|PUT|PATCH|DELETE)\(/.test(s)
          && (s.match(/requireFreshPlatformAccess\(/g) ?? []).length === 1 && /requireFreshPlatformAccess\("CUSTOMER_SUCCESS", "WRITE"\)/.test(s)
          && !/"READ"|PLATFORM_OPS|requirePlatformAccess\(/.test(s));
      check(`${name}: per-operator limiter right after the guard`, /limitPlatformMutation\(auth\.user\.id, "cs-incident-customer-update-/.test(s));
      check(`${name}: the token is minted from this guard result and must be the CS tier`, /incidentAudienceFor\(auth\)/.test(s) && /token\.audience !== "CUSTOMER_SUCCESS"/.test(s));
      check(`${name}: refusals are recorded (customerUpdateMutationResponse)`, /customerUpdateMutationResponse\(result, auth, "(send|preview)", id,/.test(s));
      check(`${name}: no recipient from the client (the route never reads a user id)`, !/userId|recipient/.test(s));
    }
    check("send: the actor is the CS operator", /operatorActorFrom\(auth, "CUSTOMER_SUCCESS"\)/.test(sendR));
    for (const [name, s] of [["read model", readR], ["deliveries", delR]] as const) {
      check(`${name}: GET only, requirePlatformAccess("CUSTOMER_SUCCESS", "READ"), rate-limited, CS tier`,
        /export async function GET\(/.test(s) && !/export async function (POST|PUT|PATCH|DELETE)\(/.test(s)
          && /requirePlatformAccess\("CUSTOMER_SUCCESS", "READ"\)/.test(s) && /limitByUser\(auth\.user\.id, "cs-incident-/.test(s)
          && /token\.audience !== "CUSTOMER_SUCCESS"/.test(s) && !/PLATFORM_OPS/.test(s));
    }
    const http = strip("lib/platform/incidents/customer-update/http.ts");
    check("refusals: control incident-customer-update, area CUSTOMER_SUCCESS, the incident id as target key, codes only",
      /control: "incident-customer-update", verb, code: r\.refusal, targetKey: incidentId, reasonCode: r\.reasonCode/.test(http) && /"CUSTOMER_SUCCESS"\)/.test(http));
    const reg = NOTIFICATION_REGISTRY.INCIDENT_CUSTOMER_UPDATE;
    check("registry: IN_APP only, EMAIL excluded, ':once' key on the incident id, never released",
      reg.defaultChannels.join() === "IN_APP" && reg.excludedChannels.join() === "EMAIL" && reg.dedupeKeyTemplate === "INCIDENT_CUSTOMER_UPDATE:incident:{incidentId}:once"
        && reg.dedupeNeverReleases === true && reg.status === "WIRED");
    const service = strip("lib/platform/incidents/customer-update/service.ts");
    check("service: the only createNotification call passes the subject (recipient), never a body field",
      /userId: recipient, data: \{ incidentId: v\.verdict\.id, paragraph \}/.test(service) && /const recipient = v\.subjectUserId;/.test(service));
  }

  if (failures > 0) { console.error(`\ncustomer-update.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncustomer-update.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
