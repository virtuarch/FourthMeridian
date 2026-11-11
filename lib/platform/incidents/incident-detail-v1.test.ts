/**
 * lib/platform/incidents/incident-detail-v1.test.ts  (Incident detail v1)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/incident-detail-v1.test.ts
 *
 *   1. displayStatus: the derived map (never stored) and its precedence;
 *   2. explanations: every covered code, the honest unknown fallback, probable
 *      never presented as confirmed, the code allowlist;
 *   3. remediation: customer-fixable codes NEVER offer Resync (Ops or CS);
 *      Resync only where a server retry can help;
 *   4. request-reauth reports honestly (created / suppressed_duplicate / …),
 *      and both recovery routes record the incident id in their audit detail;
 *   5. attempts summary: counts, newest first, every string allowlisted;
 *   6. THE ACCEPTANCE CASE ("Example Bank", synthetic): a NO_ACCOUNTS item-error
 *      incident ⇒ Action needed, customerActionRequired, customer-reconnect
 *      guidance, NO Resync, explanation present, attempts summary shown —
 *      end to end through `investigate` → DTO → drawer;
 *   7. the DTO allowlist: no identity, no detail, no provider text at the Ops tier.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole } from "@prisma/client";
import { createIncidentAccessors, incidentBelongsToItem, type IncidentFactsReader } from "./intelligence/index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./intelligence/audience";
import { deriveDisplayStatus, DISPLAY_STATUS_WORD, type DisplayStatusInput } from "./display-status";
import {
  allowlistedProviderCode, customerActionRequiredFor, explainProviderError, providerErrorCodeOfDetail, remedyFor, UNKNOWN_EXPLANATION_TEXT,
} from "./explanations";
import { incidentDetailDTO, recoveryActionsFor } from "./investigation-dto";
import { ATTEMPTS_SHOWN, summariseAttempts, unreadableAttempts, type RawItemAttempt } from "./attempts-summary";
import { incidentIdFromSearch, reauthRequestOutcome, verifiedIncidentId } from "./action-context";
import { CONFIRM, IncidentDetailSurface, REQUEST_REAUTH_CONFIRM_MESSAGE, reauthOutcomeText, recoveryPath } from "@/components/platform/incidents/IncidentsLead";
import { primaryGuidance } from "@/components/platform/incidents/incidents-model";
import type { IncidentInvestigation, IncidentVerdict } from "./intelligence/types";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

// ── 1. displayStatus ─────────────────────────────────────────────────────────
console.log("1. displayStatus (derived, never stored)");
{
  const base: DisplayStatusInput = { state: "active", generation: 1, previousIncidentId: null, itemStatus: "ACTIVE", providerErrorCode: null };
  const ds = (o: Partial<DisplayStatusInput>) => deriveDisplayStatus({ ...base, ...o });
  check("plain open ⇒ Active", ds({}) === "active");
  check("resolved / archived ⇒ Resolved (whatever the connection says)", ds({ state: "resolved", itemStatus: "NEEDS_REAUTH" }) === "resolved" && ds({ state: "archived" }) === "resolved");
  check("NEEDS_REAUTH connection ⇒ Action needed", ds({ itemStatus: "NEEDS_REAUTH" }) === "action-needed");
  check("ERROR + update-mode-fixable code ⇒ Action needed (ITEM_LOGIN_REQUIRED, NO_ACCOUNTS, ACCESS_NOT_GRANTED)",
    ["ITEM_LOGIN_REQUIRED", "NO_ACCOUNTS", "ACCESS_NOT_GRANTED"].every((c) => ds({ itemStatus: "ERROR", providerErrorCode: c }) === "action-needed"));
  check("ERROR + INSTITUTION_DOWN ⇒ not Action needed", ds({ itemStatus: "ERROR", providerErrorCode: "INSTITUTION_DOWN" }) === "active");
  check("recovering ⇒ Recovering", ds({ state: "recovering" }) === "recovering");
  check("generation > 1 ⇒ Recurring; previousIncidentId ⇒ Recurring", ds({ generation: 3 }) === "recurring" && ds({ previousIncidentId: "inc_prev" }) === "recurring");
  check("acknowledged ⇒ Investigating, labelled honestly as an acknowledgement", ds({ state: "acknowledged" }) === "investigating" && DISPLAY_STATUS_WORD.investigating.startsWith("Acknowledged"));
  check("precedence: Action needed > Recovering > Recurring > Investigating",
    ds({ state: "recovering", itemStatus: "NEEDS_REAUTH" }) === "action-needed" && ds({ state: "recovering", generation: 2 }) === "recovering"
    && ds({ state: "acknowledged", generation: 2 }) === "recurring");
  check("a healed (ACTIVE) connection with an old customer code is NOT Action needed", ds({ itemStatus: "ACTIVE", providerErrorCode: "NO_ACCOUNTS" }) === "active");
  check("needs-verification stays Active (ongoing=false is said elsewhere)", ds({ state: "stale-unverified" }) === "active");
  const lifecycleSrc = readFileSync("lib/platform/incidents/display-status.ts", "utf8");
  check("display-status.ts writes nothing (no db / prisma import)", !/@\/lib\/db|@prisma\/client|\.update\(|\.create\(/.test(lifecycleSrc));
}

// ── 2. explanations ──────────────────────────────────────────────────────────
console.log("\n2. explanations");
{
  const covered = ["ITEM_LOGIN_REQUIRED", "NO_ACCOUNTS", "ACCESS_NOT_GRANTED", "INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "RATE_LIMIT_EXCEEDED", "RATE_LIMIT",
    "INVALID_CREDENTIALS", "PENDING_EXPIRATION", "USER_PERMISSION_REVOKED"];
  for (const c of covered) {
    const e = explainProviderError(c);
    check(`${c}: verified, plain English, operator next step`, e.verified && e.plainEnglish.length > 10 && e.operatorNext.length > 10 && e.code === c);
  }
  check("confirmed facts state only the code (and Plaid's documented meaning) — never the probable cause",
    covered.every((c) => { const e = explainProviderError(c); return e.confirmedFacts.length > 0 && e.confirmedFacts.every((f) => !e.probableCause || !f.includes(e.probableCause)); }));
  check("every covered code's first confirmed fact names the code", covered.every((c) => explainProviderError(c).confirmedFacts[0].includes(c === "RATE_LIMIT" || c === "RATE_LIMIT_EXCEEDED" ? "rate-limit" : c)));
  const unknown = explainProviderError("ITEM_LOCKED");
  check("known-but-unexplained code ⇒ the honest fallback, remedy investigate, no probable cause", !unknown.verified && unknown.plainEnglish === UNKNOWN_EXPLANATION_TEXT && unknown.probableCause === null && unknown.remedy === "investigate");
  const none = explainProviderError(null);
  check("no code ⇒ says none was recorded; no facts claimed", !none.verified && none.confirmedFacts.length === 0 && /No provider error code/.test(none.plainEnglish));
  check("allowlist: known code passes; free text / lowercase / injected values do not",
    allowlistedProviderCode("NO_ACCOUNTS") === "NO_ACCOUNTS" && allowlistedProviderCode("the user's bank said no") === null
    && allowlistedProviderCode("no_accounts") === null && allowlistedProviderCode("MADE_UP_CODE") === null && allowlistedProviderCode(42) === null);
  check("detail: only `errorCode` is read, allowlisted; unknown values are flagged, not echoed",
    providerErrorCodeOfDetail({ stage: "plaid-item-error", errorCode: "NO_ACCOUNTS", message: "x" }).code === "NO_ACCOUNTS"
    && JSON.stringify(providerErrorCodeOfDetail({ errorCode: "Something <b>odd</b>" })) === JSON.stringify({ code: null, unrecognised: true })
    && providerErrorCodeOfDetail(null).code === null && providerErrorCodeOfDetail(["NO_ACCOUNTS"]).code === null);
  check("remedy: customer codes ⇒ customer-reconnect; outage ⇒ server-retry; revoked ⇒ re-add",
    remedyFor("NO_ACCOUNTS", "ERROR") === "customer-reconnect" && remedyFor("ITEM_LOGIN_REQUIRED", "NEEDS_REAUTH") === "customer-reconnect"
    && remedyFor("INSTITUTION_DOWN", "ERROR") === "server-retry" && remedyFor(null, "REVOKED") === "customer-re-add" && remedyFor("USER_PERMISSION_REVOKED", "ERROR") === "customer-re-add");
  check("customerActionRequiredFor follows the remedy", customerActionRequiredFor("NO_ACCOUNTS", "ERROR") && !customerActionRequiredFor("RATE_LIMIT", "ERROR") && !customerActionRequiredFor("NO_ACCOUNTS", "ACTIVE"));
}

// ── 3. remediation offer rules ───────────────────────────────────────────────
console.log("\n3. remediation: never Resync for a customer-fixable code");
{
  const verdict = (o: Partial<IncidentVerdict> = {}) => ({
    id: "inc_x", rowClass: "incident", state: "active", provider: "PLAID", plaidItemId: "item_x", subjectState: "LIVE", subjectUserId: "u_cust_0000000001", ...o,
  }) as unknown as IncidentVerdict;
  const inv = (status: string, code: string | null, v = verdict()) => ({
    verdict: v, affected: { provider: "PLAID", institution: "Example Bank", itemCount: 1, accountCount: 1, subjectState: "LIVE" as const, itemStatus: status },
    providerError: { code, source: code ? "connection" as const : null, unrecognised: false },
  });
  const kinds = (status: string, code: string | null, tier: "ops" | "cs" = "ops") => recoveryActionsFor(inv(status, code), tier).map((a) => a.kind).join(",");
  for (const c of ["ITEM_LOGIN_REQUIRED", "NO_ACCOUNTS", "ACCESS_NOT_GRANTED", "INVALID_CREDENTIALS", "PENDING_EXPIRATION", "INVALID_ACCESS_TOKEN"]) {
    check(`ERROR + ${c} ⇒ request-reauth only (no resync)`, kinds("ERROR", c) === "request-reauth", kinds("ERROR", c));
  }
  check("NEEDS_REAUTH (any code) ⇒ request-reauth only", kinds("NEEDS_REAUTH", null) === "request-reauth" && kinds("NEEDS_REAUTH", "INSTITUTION_DOWN") === "request-reauth");
  check("ERROR + INSTITUTION_DOWN / NOT_RESPONDING / RATE_LIMIT ⇒ resync only (reconnecting can't fix an outage)",
    kinds("ERROR", "INSTITUTION_DOWN") === "resync" && kinds("ERROR", "INSTITUTION_NOT_RESPONDING") === "resync" && kinds("ERROR", "RATE_LIMIT") === "resync");
  check("ERROR + USER_PERMISSION_REVOKED ⇒ nothing (only the customer can re-add)", kinds("ERROR", "USER_PERMISSION_REVOKED") === "");
  check("ERROR with no verified explanation ⇒ resync + request-reauth (operator judgement)", kinds("ERROR", null) === "resync,request-reauth" && kinds("ERROR", "ITEM_LOCKED") === "resync,request-reauth");
  check("ACTIVE, no code ⇒ resync only; never request-reauth on a healthy connection", kinds("ACTIVE", null) === "resync");
  check("ACTIVE with an old customer code (customer already reconnected) ⇒ resync to prove recovery", kinds("ACTIVE", "NO_ACCOUNTS") === "resync");
  check("CS: a customer-fixable incident gets NO Refresh all (it is a server retry too)", kinds("ERROR", "NO_ACCOUNTS", "cs") === "" && kinds("NEEDS_REAUTH", null, "cs") === "");
  check("CS: a server-side incident keeps Refresh all", kinds("ERROR", "INSTITUTION_DOWN", "cs") === "refresh-customer");
  check("closed ⇒ nothing", recoveryActionsFor(inv("ERROR", "INSTITUTION_DOWN", verdict({ state: "resolved" })), "ops").length === 0);
}

// ── 4. honest request-reauth + incident id on the audit ─────────────────────
console.log("\n4. request-reauth reports what happened; audits name the incident");
{
  check("outcome map", reauthRequestOutcome(true, "created") === "created" && reauthRequestOutcome(false, "suppressed") === "suppressed_duplicate"
    && reauthRequestOutcome(true, "skipped") === "marked_not_notified" && reauthRequestOutcome(false, "error") === "no_change" && reauthRequestOutcome(false, "removed") === "no_change");
  const route = readFileSync("app/api/platform/platform-ops/connections/[id]/request-reauth/route.ts", "utf8");
  check("route: no bare { ok: true } — it returns the outcome", !/json\(\{\s*ok:\s*true\s*\}\)/.test(route) && /NextResponse\.json\(\{ outcome, statusChanged, notice \}\)/.test(route));
  check("route: the outcome and the VERIFIED incident id go into the operator-action audit",
    /outcome, statusChanged, notice, \.\.\.incidentAuditDetail\(incidentId\)/.test(route)
    && /const incidentId = await verifiedIncidentId\(incidentIdFromSearch\(req\.nextUrl\.searchParams\), item\.id, incidentBelongsToItem\)/.test(route));
  check("route: verification runs after the guard and both limiters",
    route.indexOf("requireFreshPlatformAccess(") < route.indexOf("limitByUser(") && route.indexOf("limitByKey(item.id") < route.indexOf("verifiedIncidentId(incidentIdFromSearch"));
  const resync = readFileSync("app/api/platform/platform-ops/connections/[id]/resync/route.ts", "utf8");
  check("resync: only a VERIFIED incident id rides the resync audit rows, after guard + limiter + item read",
    /incidentAuditDetail\(await verifiedIncidentId\(incidentIdFromSearch\(req\.nextUrl\.searchParams\), item\.id, incidentBelongsToItem\)\)/.test(resync)
    && /outcome, \.\.\.incidentRef, \.\.\.extra/.test(resync)
    && resync.indexOf("limitPlatformMutation(") < resync.indexOf("verifiedIncidentId(") && resync.indexOf("plaidItem.findUnique") < resync.indexOf("verifiedIncidentId("));
  check("R1: the request-reauth confirmation says exactly what the customer receives",
    CONFIRM["request-reauth"].message === "Marks the connection as needing reauthorization and sends the customer an in-app notice and an email asking them to reconnect (unless one is already open). It does NOT remove the connection or any data. Audited as an operator action."
    && REQUEST_REAUTH_CONFIRM_MESSAGE === CONFIRM["request-reauth"].message);
  check("both routes keep the fresh PLATFORM_OPS WRITE guard", [route, resync].every((s) => /requireFreshPlatformAccess\(\s*"PLATFORM_OPS",\s*"WRITE"\s*\)/.test(s)));
  check("incidentId param: id-shaped only", incidentIdFromSearch(new URLSearchParams("incidentId=inc_123")) === "inc_123"
    && incidentIdFromSearch(new URLSearchParams("incidentId=../x")) === null && incidentIdFromSearch(new URLSearchParams("")) === null);
  check("the drawer posts with ?incidentId= (Ops routes only)", recoveryPath({ kind: "resync", connectionId: "a" }, "inc_1") === "/api/platform/platform-ops/connections/a/resync?incidentId=inc_1"
    && recoveryPath({ kind: "refresh-customer", userId: "u" }, "inc_1") === "/api/platform/customer-success/customers/u/refresh");
  check("the UI says a deduped request sent nothing new", /No new notice sent/.test(reauthOutcomeText({ outcome: "suppressed_duplicate" })) && /did not report/.test(reauthOutcomeText({ ok: true })));
}

// ── 5. attempts summary ──────────────────────────────────────────────────────
console.log("\n5. attempts summary");
{
  const w = { from: hoursAgo(48).toISOString(), to: NOW.toISOString() };
  const raw: RawItemAttempt[] = Array.from({ length: 12 }, (_, i) => ({
    startedAt: hoursAgo(i * 3), trigger: i === 0 ? "OPERATOR" : "CRON", overallStatus: i === 11 ? "SUCCEEDED" : "FAILED",
    failedCall: i === 11 ? null : { status: "FAILED", httpStatus: 400, errorCode: i === 1 ? "free text leak" : "NO_ACCOUNTS", operation: i === 2 ? "bad op; drop" : "transactionsSync" },
  }));
  const s = summariseAttempts(raw, w);
  check("counts", s.readable && s.counts.total === 12 && s.counts.failed === 11 && s.counts.succeeded === 1 && !s.truncated);
  check(`newest first, capped at ${ATTEMPTS_SHOWN}`, s.recent.length === ATTEMPTS_SHOWN && s.recent[0].at === hoursAgo(0).toISOString() && s.recent[0].trigger === "OPERATOR");
  check("codes / operations allowlisted (free text dropped, never echoed)", s.recent[1].errorCode === null && s.recent[2].operation === null && !JSON.stringify(s).includes("leak") && !JSON.stringify(s).includes("drop"));
  check("last success / last failure", s.lastSucceededAt === hoursAgo(33).toISOString() && s.lastFailedAt === hoursAgo(0).toISOString());
  check("an unknown trigger / status becomes OTHER", summariseAttempts([{ startedAt: NOW, trigger: "weird", overallStatus: "??", failedCall: null }], w).recent[0].trigger === "OTHER");
  check("unreadable is never 'none'", !unreadableAttempts(w).readable);
}

// ── 6. THE ACCEPTANCE CASE — NO_ACCOUNTS at "Example Bank" (synthetic) ──────
const ITEM = { id: "item_eb", status: "ERROR", errorCode: "NO_ACCOUNTS", userId: "u_owner_00000000001", institutionName: "Example Bank" };
const INCIDENT = {
  id: "inc_eb_no_accounts", kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: ITEM.id, financialAccountId: null, plaidTransactionId: null,
  detail: { stage: "plaid-item-error", cursorBlocking: true, errorCode: "NO_ACCOUNTS", from: "ACTIVE", to: "ERROR", runId: "run_secret_ref" },
  resolved: false, incidentKey: "v1::PLAID::item:item_eb::transactions::plaid-item-error", previousIncidentId: null,
  createdAt: hoursAgo(30), firstOccurredAt: hoursAgo(30), lastOccurredAt: hoursAgo(2), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
  lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: ITEM.userId, causeStatus: null, causeCode: null,
  resolutionEvidence: null, _count: { occurrences: 9 },
};
const ATTEMPTS: RawItemAttempt[] = [
  { startedAt: hoursAgo(2), trigger: "CRON", overallStatus: "FAILED", failedCall: { status: "FAILED", httpStatus: 400, errorCode: "NO_ACCOUNTS", operation: "transactionsSync" } },
  { startedAt: hoursAgo(8), trigger: "OPERATOR", overallStatus: "FAILED", failedCall: { status: "FAILED", httpStatus: 400, errorCode: "NO_ACCOUNTS", operation: "transactionsSync" } },
  { startedAt: hoursAgo(26), trigger: "CRON", overallStatus: "FAILED", failedCall: { status: "FAILED", httpStatus: 400, errorCode: "NO_ACCOUNTS", operation: "accountsGet" } },
];
let attemptArgs: { plaidItemId: string; from: Date; to: Date; take: number } | null = null;
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: { id?: unknown } }) => (a.where && "id" in a.where && a.where.id === INCIDENT.id ? [INCIDENT] : [])) as never },
  syncIssueOccurrence: { findMany: (async () => []) as never, groupBy: (async () => []) as never },
  syncIssueArchive: { findMany: (async () => []) as never },
  syncIssueRelation: { findMany: (async () => []) as never },
  syncIssueEvent: { findMany: (async () => [
    { id: "ev_1", incidentId: INCIDENT.id, at: hoursAgo(30), type: "OBSERVED", actorKind: "SYSTEM", actorId: null, auditId: null, fromState: null, toState: "ACTIVE", causeCode: null, actionCode: null, outcomeCode: null, refEventId: null, refreshExecutionId: null, jobRunId: null },
  ]) as never },
  financialAccount: { findMany: (async () => []) as never },
  plaidItem: { findMany: (async () => [ITEM]) as never },
  latestAttempts: (async () => []) as never,
  recentAttempts: (async (a: { plaidItemId: string; from: Date; to: Date; take: number }) => { attemptArgs = a; return ATTEMPTS; }) as never,
};
const acc = createIncidentAccessors(client);
const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;

async function main(): Promise<void> {
  console.log("\n6. acceptance: NO_ACCOUNTS item-error incident at Example Bank");
  const inv = await acc.investigate(ops, INCIDENT.id, { now: NOW });
  check("investigate finds it", inv !== null);
  if (!inv) { process.exit(1); }
  check("providerError = NO_ACCOUNTS from the connection (current code)", inv.providerError?.code === "NO_ACCOUNTS" && inv.providerError.source === "connection");
  check("attempts read over the incident's window for this connection only",
    attemptArgs !== null && attemptArgs!.plaidItemId === ITEM.id && attemptArgs!.from.getTime() === hoursAgo(30).getTime() && attemptArgs!.to.getTime() === NOW.getTime());
  const d = incidentDetailDTO(inv, "ops", NOW);
  check("status: Action needed", d.summary.displayStatus === "action-needed", d.summary);
  check("customerActionRequired + remedy customer-reconnect + ongoing", d.summary.customerActionRequired && d.summary.remedy === "customer-reconnect" && d.summary.ongoing);
  check("timestamps: first detected / last observed / not resolved", d.summary.firstDetectedAt === hoursAgo(30).toISOString() && d.summary.lastObservedAt === hoursAgo(2).toISOString() && d.summary.resolvedAt === null);
  check("NO Resync offered; request-reauth is the only action", JSON.stringify(d.recovery) === JSON.stringify([{ kind: "request-reauth", connectionId: ITEM.id }]));
  check("diagnosis: verified code + attempts summary (3 failed, 0 succeeded)",
    d.diagnosis.providerErrorCode === "NO_ACCOUNTS" && d.diagnosis.attempts?.counts.failed === 3 && d.diagnosis.attempts.counts.succeeded === 0 && d.diagnosis.attempts.recent[0].httpStatus === 400);
  const g = primaryGuidance(d, explainProviderError("NO_ACCOUNTS").customerAction);
  check("primary guidance = customer reconnect (text, with why no resync)", g?.headline === "Customer must reconnect" && /re-select the accounts/.test(g.body) && /resync can't fix/.test(g.caveat ?? ""));
  const html = renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: true, onSelect: () => {}, onRecover: () => {}, onLifecycle: () => {} }));
  check("drawer: status pill 'Action needed' first, impact line, guidance block", /data-status-pill[^>]*>.*Action needed/.test(html) && html.includes("data-incident-impact") && html.includes('data-incident-guidance="customer-reconnect"')
    && html.indexOf("data-status-pill") < html.indexOf("data-incident-guidance") && html.indexOf("data-incident-guidance") < html.indexOf("data-incident-diagnosis"));
  check("drawer: impact names the institution and the customer step", /Example Bank.*isn(&#x27;|')t updating until the customer reconnects/.test(html));
  check("drawer: no Resync button anywhere", !html.includes("Resync connection") && !html.includes('data-recovery-action="resync"') && html.includes('data-recovery-action="request-reauth"'));
  check("drawer: explanation, confirmed facts, LABELLED probable cause, code", html.includes('data-incident-diagnosis="verified"') && html.includes("data-confirmed-facts")
    && html.includes("Likely cause (not confirmed)") && html.includes("NO_ACCOUNTS · the connection") && html.includes("no longer sharing any accounts"));
  check("drawer: attempts summary shown, details behind disclosures", html.includes("data-incident-attempts-summary") && html.includes("3 sync attempts") && html.includes('data-disclosure="attempts"')
    && html.includes('data-disclosure="timeline"') && html.includes('data-disclosure="technical"') && (html.match(/<details/g) ?? []).length === 5 && html.includes('data-disclosure="diagnosis"'));
  check("drawer: extension slots render nothing until passed", !/ai-assessment|customer-message/i.test(html));
  const withSlots = renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: true, onSelect: () => {}, onRecover: () => {}, slots: { aiAssessment: createElement("p", { "data-slot": "ai" }), customerMessage: createElement("p", { "data-slot": "msg" }) } }));
  check("…and render in place when passed", withSlots.includes('data-slot="ai"') && withSlots.includes('data-slot="msg"'));

  console.log("\n7. DTO allowlist — Ops tier is identity-free and carries no detail / provider text");
  const csInv = await acc.investigate(cs, INCIDENT.id, { now: NOW });
  const opsFromCs = JSON.stringify(incidentDetailDTO(csInv!, "ops", NOW));
  const opsJson = JSON.stringify(d);
  for (const [name, j] of [["ops", opsJson], ["ops projection of a CS verdict", opsFromCs]] as const) {
    check(`${name}: no customer id, no subjectUserId key`, !j.includes(ITEM.userId) && !j.includes("subjectUserId"));
    check(`${name}: no detail passthrough (stage / runId / from-to), no request ids`, !/"detail"|cursorBlocking|run_secret_ref|providerRequestId|errorSummary|"stage"/.test(j));
  }
  check("control: CS tier names the customer", JSON.stringify(incidentDetailDTO(csInv!, "cs", NOW)).includes(ITEM.userId));
  const keys = Object.keys(d).sort().join();
  check("detail DTO keys are exactly the allowlist", keys === "affected,archive,checkedAt,component,diagnosis,evidence,incident,lifecycleActions,recovery,recurrences,recurrencesTruncated,related,resolutionReasonCode,summary,tier,timeline", keys);
  check("summary / diagnosis keys are exactly the allowlist",
    Object.keys(d.summary).sort().join() === "customerActionRequired,displayStatus,firstDetectedAt,lastObservedAt,ongoing,remedy,resolvedAt"
    && Object.keys(d.diagnosis).sort().join() === "attempts,providerErrorCode,providerErrorSource,providerErrorUnrecognised,recurrence");

  console.log("\n8. history: a resolved episode reads the code it recorded; recurrence");
  const resolvedInv = { ...inv, verdict: { ...inv.verdict, state: "resolved", resolvedAt: hoursAgo(1).toISOString(), recurrence: { ...inv.verdict.recurrence, generation: 2, previousIncidentId: "inc_prev" } } } as IncidentInvestigation;
  const rd = incidentDetailDTO(resolvedInv, "ops", NOW);
  check("resolved ⇒ Resolved, not ongoing, no customer action, no recovery", rd.summary.displayStatus === "resolved" && !rd.summary.ongoing && !rd.summary.customerActionRequired && rd.recovery.length === 0);
  check("recurrence: generation 2 ⇒ at least one earlier episode", rd.diagnosis.recurrence.generation === 2 && rd.diagnosis.recurrence.earlierEpisodes >= 1 && rd.diagnosis.recurrence.previousIncidentId === "inc_prev");

  console.log("\n9. S2 R2 — the audit's incidentId is verified server-side");
  const rows: Record<string, { plaidItemId: string | null }> = { inc_on_item: { plaidItemId: "item_1" }, inc_other_item: { plaidItemId: "item_2" }, inc_no_item: { plaidItemId: null } };
  let reads = 0;
  const fake = { syncIssue: { findUnique: (async (a: { where: { id: string }; select: Record<string, boolean> }) => {
    reads++;
    if (a.where.id === "inc_boom") throw new Error("db down");
    const keys = Object.keys(a.select).join();
    return keys === "plaidItemId" ? (rows[a.where.id] ?? null) : { leaked: true };
  }) as never } };
  const belongs = (id: string, item: string) => incidentBelongsToItem(id, item, fake);
  check("matching id (exists, names this connection) ⇒ recorded", (await verifiedIncidentId("inc_on_item", "item_1", belongs)) === "inc_on_item");
  check("another connection's incident ⇒ dropped", (await verifiedIncidentId("inc_other_item", "item_1", belongs)) === null);
  check("unknown id ⇒ dropped", (await verifiedIncidentId("inc_missing", "item_1", belongs)) === null);
  check("incident with no connection ⇒ dropped", (await verifiedIncidentId("inc_no_item", "item_1", belongs)) === null);
  check("a failed read ⇒ dropped silently (never throws)", (await verifiedIncidentId("inc_boom", "item_1", belongs)) === null);
  const before = reads;
  check("no candidate / malformed ⇒ dropped with NO read", (await verifiedIncidentId(null, "item_1", belongs)) === null && (await incidentBelongsToItem("../x", "item_1", fake)) === false && reads === before);
  check("ONE primary-key read selecting plaidItemId only", (await incidentBelongsToItem("inc_on_item", "item_1", fake)) && reads === before + 1);

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nincident-detail-v1.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
