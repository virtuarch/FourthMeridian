/**
 * lib/platform/incidents/incident-diagnosis.test.ts  (Incident detail — Diagnosis section, owner item 2)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs lib/platform/incidents/incident-diagnosis.test.ts
 *
 *   1. cause: causeStatus CONFIRMED ⇒ "Confirmed cause", HYPOTHESIS ⇒ "Likely
 *      cause (not confirmed)", worded from the registry only; the code table's
 *      probable cause is always "likely"; an unregistered cause code is not shown;
 *   2. codes: verified explanation; allowlisted-but-unexplained ⇒ the generic
 *      "we don't recognise" sentence + the code; a non-allowlisted value is never
 *      echoed;
 *   3. reconnect class (consent / NO_ACCOUNTS / ITEM_LOGIN_REQUIRED …): the text
 *      says the customer must reconnect and never suggests a server retry; no
 *      control is added; re-add class; server-retry ⇒ no customer step;
 *   4. attempts: counts + last attempt / skip / success / failure;
 *   5. prior occurrences + how each closed;
 *   6. NO FREE TEXT: a sentinel planted in `detail` and in provider text never
 *      reaches the view-model or the rendered drawer — end to end through
 *      `investigate` → DTO → view → markup;
 *   7. tier identity: the diagnosis is identity-free on BOTH tiers (no customer
 *      id, no institution name), and adds no actions.
 *
 * Synthetic data; institution "Example Bank".
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserRole } from "@prisma/client";
import { createIncidentAccessors, type IncidentFactsReader } from "./intelligence/index";
import { incidentAudienceFor, type CsToken, type OpsToken } from "./intelligence/audience";
import { incidentDetailDTO, type IncidentDetailDTO, type IncidentRowDTO } from "./investigation-dto";
import { UNKNOWN_EXPLANATION_TEXT } from "./explanations";
import type { RawItemAttempt } from "./attempts-summary";
import { IncidentDetailSurface } from "@/components/platform/incidents/IncidentsLead";
import {
  CONFIRMED_CAUSE_LABEL, LIKELY_CAUSE_LABEL, RECONNECT_ONLY_TEXT, RE_ADD_ONLY_TEXT, UNRECOGNISED_ERROR_TEXT, incidentDiagnosisView,
} from "@/components/platform/incidents/diagnosis-model";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-08T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const SENTINEL = "SENTINEL_FREE_TEXT_7f3a";
const SENTINEL_CODE = "ZZ_SENTINEL_CODE_7F3A";

// ── fixture: a NO_ACCOUNTS incident whose detail and provider text carry sentinels ──
const ITEM = { id: "item_dx", status: "ERROR", errorCode: "NO_ACCOUNTS", errorMessage: `${SENTINEL} provider message`, userId: "u_owner_00000000077", institutionName: "Example Bank" };
const INCIDENT = {
  id: "inc_dx", kind: "UPSERT_ERROR", provider: "PLAID", plaidItemId: ITEM.id, financialAccountId: null, plaidTransactionId: null,
  detail: { stage: "plaid-item-error", errorCode: "NO_ACCOUNTS", message: `${SENTINEL} detail message`, errorMessage: SENTINEL, displayMessage: SENTINEL, runId: SENTINEL },
  resolved: false, incidentKey: "v1::PLAID::item:item_dx::transactions::plaid-item-error", previousIncidentId: null,
  createdAt: hoursAgo(30), firstOccurredAt: hoursAgo(30), lastOccurredAt: hoursAgo(2), resolvedAt: null, resolutionKind: null, resolutionReasonCode: null,
  lifecycleState: null, acknowledgedAt: null, recoveringSince: null, archivedAt: null, subjectUserId: ITEM.userId, causeStatus: "HYPOTHESIS", causeCode: "PROVIDER_DATA_DEFECT",
  resolutionEvidence: null, _count: { occurrences: 4 },
};
const ATTEMPTS: RawItemAttempt[] = [
  { startedAt: hoursAgo(2), trigger: "CRON", overallStatus: "FAILED", failedCall: { status: "FAILED", httpStatus: 400, errorCode: SENTINEL, operation: "transactionsSync" } },
  { startedAt: hoursAgo(5), trigger: "CRON", overallStatus: "SKIPPED", failedCall: null },
  { startedAt: hoursAgo(8), trigger: "OPERATOR", overallStatus: "FAILED", failedCall: { status: "FAILED", httpStatus: 400, errorCode: "NO_ACCOUNTS", operation: SENTINEL } },
  { startedAt: hoursAgo(40), trigger: "CRON", overallStatus: "SUCCEEDED", failedCall: null },
];
const client: IncidentFactsReader = {
  syncIssue: { findMany: (async (a: { where?: { id?: unknown } }) => (a.where && "id" in a.where && a.where.id === INCIDENT.id ? [INCIDENT] : [])) as never },
  syncIssueOccurrence: { findMany: (async () => []) as never, groupBy: (async () => []) as never },
  syncIssueArchive: { findMany: (async () => []) as never },
  syncIssueRelation: { findMany: (async () => []) as never },
  syncIssueEvent: { findMany: (async () => []) as never },
  financialAccount: { findMany: (async () => []) as never },
  plaidItem: { findMany: (async () => [ITEM]) as never },
  latestAttempts: (async () => []) as never,
  recentAttempts: (async () => ATTEMPTS) as never,
};
const acc = createIncidentAccessors(client);
const ops = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "PLATFORM_OPS", level: "READ" } as never }) as OpsToken;
const cs = incidentAudienceFor({ user: { role: UserRole.USER }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } as never }) as CsToken;

type Dx = Partial<IncidentDetailDTO["diagnosis"]>;
function variant(base: IncidentDetailDTO, o: { incident?: Partial<IncidentRowDTO>; summary?: Partial<IncidentDetailDTO["summary"]>; diagnosis?: Dx; recurrences?: IncidentRowDTO[]; related?: IncidentDetailDTO["related"] } = {}): IncidentDetailDTO {
  return {
    ...base,
    incident: { ...base.incident, ...o.incident },
    summary: { ...base.summary, ...o.summary },
    diagnosis: { ...base.diagnosis, ...o.diagnosis },
    recurrences: o.recurrences ?? base.recurrences,
    related: o.related ?? base.related,
  };
}
/** The Diagnosis section's markup only (from its heading to the next section). */
function diagnosisHtml(html: string): string {
  const i = html.indexOf(">Diagnosis</h3>");
  return i < 0 ? "" : html.slice(i, html.indexOf("</section>", i));
}
const render = (d: IncidentDetailDTO) => renderToStaticMarkup(createElement(IncidentDetailSurface, { d, canWrite: true, onSelect: () => {}, onRecover: () => {}, onLifecycle: () => {} }));

async function main(): Promise<void> {
  const inv = await acc.investigate(ops, INCIDENT.id, { now: NOW });
  const csInv = await acc.investigate(cs, INCIDENT.id, { now: NOW });
  if (!inv || !csInv) { console.error("investigate returned null"); process.exit(1); }
  const d = incidentDetailDTO(inv, "ops", NOW);
  const dcs = incidentDetailDTO(csInv, "cs", NOW);

  console.log("1. confirmed vs likely cause");
  {
    const v = incidentDiagnosisView(d);
    const inc = v.causes.find((c) => c.source === "incident");
    check("HYPOTHESIS ⇒ 'Likely cause (not confirmed)', registry words", inc?.status === "likely" && inc.label === LIKELY_CAUSE_LABEL && inc.text === "The provider returned data that could not be stored as delivered", v.causes);
    const conf = incidentDiagnosisView(variant(d, { incident: { causeStatus: "CONFIRMED", causeCode: "PROVIDER_OUTAGE" } }));
    check("CONFIRMED ⇒ 'Confirmed cause', listed first", conf.causes[0].status === "confirmed" && conf.causes[0].label === CONFIRMED_CAUSE_LABEL && conf.causes[0].text === "The provider was unavailable or erroring", conf.causes);
    check("the code table's probable cause is ALWAYS likely, never confirmed", [v, conf].every((x) => x.causes.filter((c) => c.source === "provider-code").every((c) => c.status === "likely" && c.label === LIKELY_CAUSE_LABEL)));
    check("labels are exact", CONFIRMED_CAUSE_LABEL === "Confirmed cause" && LIKELY_CAUSE_LABEL === "Likely cause (not confirmed)");
    const unreg = incidentDiagnosisView(variant(d, { incident: { causeStatus: "CONFIRMED", causeCode: "NOT_A_REGISTERED_CAUSE" } }));
    check("unregistered cause code ⇒ flagged, not shown, never 'confirmed'", unreg.unregisteredCause && !JSON.stringify(unreg.causes).includes("NOT_A_REGISTERED_CAUSE") && unreg.causes.every((c) => c.status === "likely"));
    const proto = incidentDiagnosisView(variant(d, { incident: { causeStatus: "CONFIRMED", causeCode: "toString" } }));
    check("a prototype key is not a registry code", proto.unregisteredCause && proto.causes.every((c) => c.source !== "incident"));
    const none = incidentDiagnosisView(variant(d, { incident: { causeStatus: null, causeCode: null } }));
    check("no cause code ⇒ only the code table's likely cause", none.causes.length === 1 && none.causes[0].source === "provider-code" && !none.unregisteredCause);
    const html = diagnosisHtml(render(variant(d, { incident: { causeStatus: "CONFIRMED", causeCode: "PROVIDER_OUTAGE" } })));
    check("rendered: confirmed and likely carry their own labels and data-cause-status", html.includes('data-cause-status="confirmed"') && html.includes("Confirmed cause: ") && html.includes('data-cause-status="likely"') && html.includes("Likely cause (not confirmed): ")
      && html.indexOf('data-cause-status="confirmed"') < html.indexOf('data-cause-status="likely"'));
  }

  console.log("\n2. error codes: verified, unexplained, unrecognised");
  {
    const v = incidentDiagnosisView(d);
    check("verified NO_ACCOUNTS: table plain English + code line + confirmed facts", v.verified && /no longer sharing any accounts/.test(v.plainEnglish) && v.codeLine === "NO_ACCOUNTS · the connection's current error" && v.confirmedFacts.length > 0);
    const unk = incidentDiagnosisView(variant(d, { diagnosis: { providerErrorCode: "ITEM_LOCKED", providerErrorSource: "incident" } }));
    check("allowlisted but unexplained ⇒ generic 'we don't recognise' + the code", !unk.verified && unk.plainEnglish === "The provider returned an error we don't recognise (ITEM_LOCKED)." && unk.codeLine === "ITEM_LOCKED · recorded when the incident opened");
    check("…and never the old fallback wording or a likely cause", unk.plainEnglish !== UNKNOWN_EXPLANATION_TEXT && unk.causes.every((c) => c.source !== "provider-code"));
    const unrec = incidentDiagnosisView(variant(d, { diagnosis: { providerErrorCode: null, providerErrorSource: null, providerErrorUnrecognised: true } }));
    check("non-allowlisted value ⇒ the generic sentence, no code line, an honest note", unrec.plainEnglish === UNRECOGNISED_ERROR_TEXT && unrec.codeLine === null && /isn't a known provider error code/.test(unrec.unrecognisedNote ?? ""));
    const nocode = incidentDiagnosisView(variant(d, { diagnosis: { providerErrorCode: null, providerErrorSource: null, providerErrorUnrecognised: false } }));
    check("no code at all ⇒ says none was recorded", /No provider error code/.test(nocode.plainEnglish) && nocode.codeLine === null && nocode.unrecognisedNote === null && nocode.confirmedFacts.length === 0);
  }

  console.log("\n3. reconnect-class codes: customer must reconnect, no server retry");
  {
    for (const code of ["NO_ACCOUNTS", "ITEM_LOGIN_REQUIRED", "ACCESS_NOT_GRANTED", "PENDING_EXPIRATION", "INVALID_CREDENTIALS"]) {
      const v = incidentDiagnosisView(variant(d, { diagnosis: { providerErrorCode: code } }));
      check(`${code}: customer step = reconnect; no retry suggested`, v.customerStep?.kind === "reconnect" && v.customerStep.text === RECONNECT_ONLY_TEXT
        && /can't fix it/.test(v.customerStep.text) && !/\b(try|run) a resync\b|resync (may|will|should) help|retry (may|will|should) help/i.test(JSON.stringify(v)), v.operatorNext);
    }
    check("RECONNECT text names the customer and rules out a retry", /customer reconnecting/.test(RECONNECT_ONLY_TEXT) && /Retrying the sync from our side can't fix it/.test(RECONNECT_ONLY_TEXT));
    const revoked = incidentDiagnosisView(variant(d, { diagnosis: { providerErrorCode: "USER_PERMISSION_REVOKED" } }));
    check("USER_PERMISSION_REVOKED ⇒ re-add step", revoked.customerStep?.kind === "re-add" && revoked.customerStep.text === RE_ADD_ONLY_TEXT);
    const outage = incidentDiagnosisView(variant(d, { summary: { remedy: "server-retry", customerActionRequired: false }, diagnosis: { providerErrorCode: "INSTITUTION_DOWN" } }));
    check("INSTITUTION_DOWN ⇒ no customer step", outage.customerStep === null);
    const reauth = incidentDiagnosisView(variant(d, { summary: { remedy: "customer-reconnect" }, diagnosis: { providerErrorCode: null } }));
    check("NEEDS_REAUTH connection without a code ⇒ reconnect step from the summary", reauth.customerStep?.kind === "reconnect");
    const html = render(d);
    check("rendered: the reconnect step is TEXT inside Diagnosis (no new control)", diagnosisHtml(html).includes('data-diagnosis-customer-step="reconnect"') && !/<button[^>]*data-diagnosis/.test(html) && !html.includes("Resync connection"));
    const resolved = incidentDiagnosisView(variant(d, { summary: { displayStatus: "resolved", remedy: null, customerActionRequired: false } }));
    check("resolved ⇒ no 'next step'", resolved.operatorNext === null);
  }

  console.log("\n4. attempts");
  {
    const v = incidentDiagnosisView(d);
    const st = Object.fromEntries(v.attempts.stamps.map((s) => [s.label, s.value]));
    check("counts line from the attempts summary", /4 sync attempts/.test(v.attempts.line) && /1 succeeded/.test(v.attempts.line) && /2 failed/.test(v.attempts.line) && /1 skipped/.test(v.attempts.line), v.attempts.line);
    check("last attempt / skip / success / failure stamps", st["Last attempt"] === "8 Nov 2026 10:00 UTC" && st["Last skip"] === "8 Nov 2026 07:00 UTC" && st["Last success"] === "6 Nov 2026 20:00 UTC" && st["Last failure"] === "8 Nov 2026 10:00 UTC", st);
    const none = incidentDiagnosisView(variant(d, { diagnosis: { attempts: null } }));
    check("no attempts summary ⇒ says so; stamps only from read attempt evidence", /aren't tracked/.test(none.attempts.line) && (d.incident.recovery.evidenceBasis === "read" || none.attempts.stamps.length === 0));
    const unreadable = incidentDiagnosisView(variant(d, { diagnosis: { attempts: { ...d.diagnosis.attempts!, readable: false } } }));
    check("unreadable ⇒ 'could not be read', never 'none'", /could not be read/.test(unreadable.attempts.line));
  }

  console.log("\n5. prior occurrences + recovery");
  {
    const prev = (id: string, gen: number, firstH: number, closedH: number | null, closure: IncidentRowDTO["closure"]): IncidentRowDTO => ({
      ...d.incident, id, generation: gen, firstSeenAt: hoursAgo(firstH).toISOString(), lastSeenAt: hoursAgo(firstH - 1).toISOString(),
      resolvedAt: closedH === null ? null : hoursAgo(closedH).toISOString(), state: closedH === null ? "active" : "resolved", closure, closureDerived: false,
    });
    const recs = [prev("inc_p2", 2, 100, 90, "recovered"), prev("inc_p1", 1, 300, 280, "operator"), prev("inc_later", 4, 1, null, null)];
    const dd = variant(d, {
      incident: { generation: 3 },
      diagnosis: { recurrence: { generation: 3, previousIncidentId: "inc_p2", earlierEpisodes: 2, truncated: false, lastRecoveredAt: hoursAgo(90).toISOString() } },
      recurrences: recs,
      related: [{ id: "inc_p2", kind: "PREVIOUS_EPISODE", incident: recs[0] }, { id: "inc_gone", kind: "PREVIOUS_EPISODE", incident: null }],
    });
    const v = incidentDiagnosisView(dd);
    check("earlier episodes only (not later / not self), newest first; a missing one is 'No longer retained'",
      v.prior.episodes.map((e) => e.id).join() === "inc_p2,inc_p1,inc_gone" && v.prior.episodes[2].outcome === "No longer retained", v.prior.episodes);
    check("each episode says how it ended", v.prior.episodes[0].outcome === "Recovered (evidence)" && v.prior.episodes[1].outcome === "Resolved by an operator");
    check("line: episode count + last closed + how", /Episode 3/.test(v.prior.line) && /2 earlier episodes/.test(v.prior.line) && /recovered \(evidence\)/.test(v.prior.line), v.prior.line);
    const html = render(dd);
    check("rendered: prior episodes inside the 'Diagnosis details' disclosure, in-drawer buttons (no new hrefs)",
      /data-disclosure="diagnosis"[\s\S]*data-prior-episode="inc_p2"/.test(html) && !/href="[^"]*inc_p1/.test(diagnosisHtml(html)));
    const first = incidentDiagnosisView(d);
    check("first occurrence ⇒ says so, no list", /First occurrence/.test(first.prior.line) && first.prior.episodes.length === 0);
  }

  console.log("\n6. no free text: sentinels in detail / provider text never surface");
  {
    for (const [name, dto] of [["ops", d], ["cs", dcs]] as const) {
      const vj = JSON.stringify(incidentDiagnosisView(dto));
      check(`${name}: view-model carries no sentinel`, !vj.includes(SENTINEL) && !vj.includes("detail message") && !vj.includes("provider message"));
      const html = render(dto);
      check(`${name}: rendered drawer carries no sentinel`, !html.includes(SENTINEL));
    }
    // An unrecognised code VALUE (not allowlisted) on both the connection and the incident's detail.
    const inv2 = await createIncidentAccessors({
      ...client,
      syncIssue: { findMany: (async (a: { where?: { id?: unknown } }) => (a.where && "id" in a.where && a.where.id === INCIDENT.id ? [{ ...INCIDENT, detail: { ...INCIDENT.detail, errorCode: SENTINEL_CODE } }] : [])) as never },
      plaidItem: { findMany: (async () => [{ ...ITEM, errorCode: SENTINEL_CODE }]) as never },
    }).investigate(ops, INCIDENT.id, { now: NOW });
    const d2 = incidentDetailDTO(inv2!, "ops", NOW);
    const v2 = incidentDiagnosisView(d2);
    check("unrecognised code value ⇒ generic sentence, never echoed (view + markup)", v2.plainEnglish === UNRECOGNISED_ERROR_TEXT && !JSON.stringify(v2).includes(SENTINEL_CODE) && !render(d2).includes(SENTINEL_CODE), v2);
  }

  console.log("\n7. tier identity: diagnosis is identity-free on both tiers; no actions added");
  {
    for (const [name, dto] of [["ops", d], ["cs", dcs]] as const) {
      const vj = JSON.stringify(incidentDiagnosisView(dto));
      check(`${name}: view-model has no customer id and no institution name`, !vj.includes(ITEM.userId) && !vj.includes("Example Bank"));
      const dh = diagnosisHtml(render(dto));
      check(`${name}: rendered Diagnosis section has no customer id / institution`, dh.length > 0 && !dh.includes(ITEM.userId) && !dh.includes("Example Bank"));
      check(`${name}: Diagnosis section has no link and no recovery/lifecycle control`, !/<a\s/.test(dh) && !/data-recovery-action|data-lifecycle-action/.test(dh));
    }
    check("control: the CS drawer still names the customer in its summary (tiered elsewhere, not in diagnosis)", render(dcs).includes(ITEM.userId) && !render(d).includes(ITEM.userId));
  }

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log("\nincident-diagnosis.test: all passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
