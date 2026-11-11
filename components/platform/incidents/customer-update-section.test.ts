/**
 * components/platform/incidents/customer-update-section.test.ts  (Incident customer update, PR-C2)
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/incidents/customer-update-section.test.ts
 *
 *   1. view-model: lint codes → plain language; the 600-char counter; the
 *      dedupe states (reauth notice created / suppressed_duplicate / non-blocking,
 *      episode already sent); the send outcome words incl. "not delivered
 *      (customer preference)" (S2 09gm 7); delivery codes → words;
 *   2. sendEnabled false ⇒ NO Send control rendered at all (S2: strict, hidden);
 *      true ⇒ rendered; blocked ⇒ rendered disabled with the reason; read-only ⇒ hidden;
 *   3. the section renders on the CS tier only (never Ops): customerMessageSlot +
 *      IncidentCustomerUpdate + the drawer wiring;
 *   4. no recipient email or name anywhere in the render or the source;
 *   5. preview shows the full message; the confirm copy is pinned.
 */

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BLOCK_WORD, INCIDENT_UPDATE_PARAGRAPH_MAX, LINT_MESSAGE, SEND_CONFIRM_MESSAGE, counterView, dedupeView, deliveryLine, lintMessages, lintParagraph,
  sendOutcomeText, sendView, summaryLine, type CustomerUpdateReadModel, type DeliveriesModel,
} from "./customer-update-model";
import { CustomerUpdateSurface, IncidentCustomerUpdate, type CustomerUpdateSurfaceProps } from "./CustomerUpdateSection";
import { customerMessageSlot, IncidentDetailSurface } from "./IncidentsLead";
import { DRAFTS, LINT_CODES } from "@/lib/platform/incidents/customer-update/core";
import {
  INCIDENT_UPDATE_CLOSING, INCIDENT_UPDATE_HREF, INCIDENT_UPDATE_OPENING, INCIDENT_UPDATE_TITLE, renderIncidentCustomerUpdate,
} from "@/lib/notifications/incident-customer-update";
import type { IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const NOW = new Date("2026-11-11T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

// Synthetic only: a fake person who must never appear in any render.
const FAKE_EMAIL = "pat.sample@example.test";
const FAKE_NAME = "Pat Sample";
const FAKE_USER_ID = "u_cust_0000000001";

function model(o: Partial<CustomerUpdateReadModel> = {}): CustomerUpdateReadModel {
  return {
    incidentId: "inc_cu_1",
    sendEnabled: false,
    eligible: true,
    recipient: { attributed: true },
    template: { title: INCIDENT_UPDATE_TITLE, opening: INCIDENT_UPDATE_OPENING, closing: INCIDENT_UPDATE_CLOSING, href: INCIDENT_UPDATE_HREF, paragraphMax: INCIDENT_UPDATE_PARAGRAPH_MAX },
    draft: { paragraph: DRAFTS["server-retry"], draftClass: "server-retry", verifiedRecovery: false, draftHash: "a".repeat(64) },
    lint: { ok: true, codes: [], length: DRAFTS["server-retry"].length, max: INCIDENT_UPDATE_PARAGRAPH_MAX },
    dedupe: { episode: { sent: false, sentAt: null }, reauthNotice: null },
    blockedBy: ["SEND_DISABLED"],
    canSend: false,
    checkedAt: NOW.toISOString(),
    ...o,
  };
}

const DELIVERIES: DeliveriesModel = {
  incidentId: "inc_cu_1",
  items: [
    { channel: "IN_APP", status: "SUPPRESSED", reason: "PREFERENCE_OFF", errorCode: null, attempt: 1, mode: "LIVE", createdAt: hoursAgo(3), acceptedAt: null },
    { channel: "IN_APP", status: "FAILED", reason: null, errorCode: "STORE", attempt: 1, mode: "LIVE", createdAt: hoursAgo(5), acceptedAt: null },
  ],
  episode: { sent: false, sentAt: null },
};

function render(o: Partial<CustomerUpdateSurfaceProps> = {}): string {
  const m = o.model === undefined ? model() : o.model;
  return renderToStaticMarkup(createElement(CustomerUpdateSurface, {
    model: m, deliveries: DELIVERIES, paragraph: m?.draft.paragraph ?? "", onParagraph: () => {}, institution: "Example Bank", canWrite: true,
    now: NOW, preview: null, onPreview: () => {}, onSend: () => {}, open: true, ...o,
  }));
}

// ── 1. view-model ────────────────────────────────────────────────────────────
console.log("1. view-model");
{
  check("every lint code has a plain-language message", LINT_CODES.every((c) => typeof LINT_MESSAGE[c] === "string" && LINT_MESSAGE[c].length > 10));
  check("lint messages never echo a code", LINT_CODES.every((c) => !LINT_MESSAGE[c].includes(c)));
  const l = lintParagraph("Call 555 0100 or visit example.com <b>now</b>", { verifiedRecovery: false });
  check("live lint: link, figure, markup", !l.ok && l.codes.includes("LINK") && l.codes.includes("FIGURE") && l.codes.includes("MARKUP"), l.codes);
  check("lintMessages maps in order", JSON.stringify(lintMessages(["MARKUP", "LINK"])) === JSON.stringify([LINT_MESSAGE.MARKUP, LINT_MESSAGE.LINK]));
  check("institution name refused (IDENTIFIER)", lintParagraph("Example Bank is having trouble.", { verifiedRecovery: false, institution: "Example Bank" }).codes.includes("IDENTIFIER"));
  check("PROMISE refused unless recovery verified",
    lintParagraph("The problem is resolved.", { verifiedRecovery: false }).codes.includes("PROMISE") && lintParagraph("The problem is resolved.", { verifiedRecovery: true }).ok);
  check("every server draft passes the live lint", Object.entries(DRAFTS).every(([k, p]) => lintParagraph(p, { verifiedRecovery: k === "recovered", institution: "Example Bank" }).ok));

  check("counter: N of 600", counterView("hello").text === `5 of ${INCIDENT_UPDATE_PARAGRAPH_MAX}` && !counterView("hello").over);
  check("counter: trimmed length", counterView("  hi  ").length === 2);
  check("counter: over the limit flagged", counterView("a".repeat(601)).over && counterView("a".repeat(600)).over === false);

  const none = dedupeView(model(), NOW);
  check("dedupe: nothing ⇒ no lines", none.reauthLine === null && none.reauthBlockLine === null && none.alreadySentLine === null);
  const created = dedupeView(model({ dedupe: { episode: { sent: false, sentAt: null }, reauthNotice: { outcome: "created", at: hoursAgo(3), blocksSend: true, quietUntil: hoursAhead(21) } } }), NOW);
  check("dedupe: created ⇒ 'Reconnect request already sent 3 h ago (notice sent)'", created.reauthLine === "Reconnect request already sent 3 h ago (notice sent).", created.reauthLine);
  check("dedupe: blocking ⇒ explains no update until 24 h after it", /No update can be sent until 24 h after it \(in 21 h\)/.test(created.reauthBlockLine ?? ""), created.reauthBlockLine);
  const dup = dedupeView(model({ dedupe: { episode: { sent: false, sentAt: null }, reauthNotice: { outcome: "suppressed_duplicate", at: hoursAgo(1), blocksSend: true, quietUntil: hoursAhead(23) } } }), NOW);
  check("dedupe: suppressed_duplicate blocks too", /1 h ago \(an open notice was already showing\)/.test(dup.reauthLine ?? "") && dup.reauthBlockLine !== null);
  const nonBlock = dedupeView(model({ dedupe: { episode: { sent: false, sentAt: null }, reauthNotice: { outcome: "marked_not_notified", at: hoursAgo(2), blocksSend: false, quietUntil: null } } }), NOW);
  check("dedupe: non-blocking outcome shown, no quiet-window line", nonBlock.reauthLine !== null && nonBlock.reauthBlockLine === null);
  const sent = dedupeView(model({ dedupe: { episode: { sent: true, sentAt: hoursAgo(6) }, reauthNotice: null } }), NOW);
  check("dedupe: episode used ⇒ 'An update was already sent for this incident'", sent.alreadySentLine === "An update was already sent for this incident.");

  check("sendView: sendEnabled false ⇒ hidden", sendView(model({ sendEnabled: false }), true).showSend === false);
  check("sendView: strict — only literal true shows", sendView(model({ sendEnabled: "true" as unknown as boolean }), true).showSend === false);
  check("sendView: enabled but read-only ⇒ hidden", sendView(model({ sendEnabled: true, blockedBy: [] }), false).showSend === false);
  check("sendView: enabled + write ⇒ shown, no blocks", (() => { const v = sendView(model({ sendEnabled: true, blockedBy: [] }), true); return v.showSend && v.blockedWords.length === 0; })());
  check("sendView: blocks in words (SEND_DISABLED never listed)",
    JSON.stringify(sendView(model({ sendEnabled: true, blockedBy: ["SEND_DISABLED", "ALREADY_SENT"] }), true).blockedWords) === JSON.stringify([BLOCK_WORD.ALREADY_SENT]));

  check("outcome: sent", /^Sent: the update is in the customer's in-app inbox/.test(sendOutcomeText(200, { outcome: "sent" })));
  check("outcome: not_delivered_preference ⇒ 'not delivered (customer preference)'", sendOutcomeText(200, { outcome: "not_delivered_preference" }).includes("not delivered (customer preference)"));
  check("outcome: refusals in words", sendOutcomeText(409, { code: "ALREADY_SENT" }).includes("already sent") && sendOutcomeText(409, { code: "REAUTH_NOTICE_RECENT" }).includes("reconnect request")
    && sendOutcomeText(404, { code: "NOT_AVAILABLE" }).includes("Nothing was sent") && sendOutcomeText(502, { code: "SEND_FAILED" }).includes("Nothing was sent")
    && sendOutcomeText(403, {}).includes("Not authorized"));
  check("outcome: never a bare 'done'", !/\bdone\b/i.test([sendOutcomeText(200, { outcome: "sent" }), sendOutcomeText(500, {})].join(" ")));

  const pref = deliveryLine(DELIVERIES.items[0], NOW);
  check("delivery: SUPPRESSED + PREFERENCE_OFF ⇒ 'In-app · Not sent (customer preference)'", pref.title === "In-app · Not sent (customer preference)" && pref.detail === "attempt 1 · 3 h ago", pref);
  check("delivery: FAILED + STORE ⇒ plain words, no code", (() => { const t = deliveryLine(DELIVERIES.items[1], NOW).title; return t.startsWith("In-app · Failed (") && !t.includes("STORE"); })());
  check("delivery: ACCEPTED ⇒ Delivered to inbox", deliveryLine({ ...DELIVERIES.items[0], status: "ACCEPTED", reason: null }, NOW).title === "In-app · Delivered to inbox");
  check("delivery: unknown codes never echoed", !/WEIRD/.test(deliveryLine({ ...DELIVERIES.items[0], status: "WEIRD_STATUS", reason: "WEIRD_REASON", channel: "WEIRD" }, NOW).title));

  check("summary: collapsed one-liners", summaryLine(null, NOW) === "Reading…" && summaryLine(model(), NOW) === "Draft ready · preview only"
    && summaryLine(model({ sendEnabled: true }), NOW) === "Draft ready" && summaryLine(model({ dedupe: { episode: { sent: true, sentAt: hoursAgo(2) }, reauthNotice: null } }), NOW) === "Sent 2 h ago"
    && summaryLine(model({ recipient: { attributed: false } }), NOW) === "No attributed customer");
}

// ── 2. the Send control: hidden unless enabled ───────────────────────────────
console.log("\n2. Send control (S2: strict, hidden when disabled)");
{
  const off = render({ model: model({ sendEnabled: false }) });
  check("sendEnabled false ⇒ NO send control in the markup at all", !off.includes("data-customer-update-send") && !/Send to customer/.test(off));
  check("sendEnabled false ⇒ Preview still offered", off.includes("data-customer-update-preview-btn"));
  const on = render({ model: model({ sendEnabled: true, blockedBy: [], canSend: true }) });
  check("sendEnabled true ⇒ send control rendered and enabled", on.includes("data-customer-update-send") && !/<button[^>]* disabled=""[^>]*data-customer-update-send/.test(on));
  const blocked = render({ model: model({ sendEnabled: true, blockedBy: ["REAUTH_NOTICE_RECENT"], dedupe: { episode: { sent: false, sentAt: null }, reauthNotice: { outcome: "created", at: hoursAgo(3), blocksSend: true, quietUntil: hoursAhead(21) } } }) });
  check("blocked ⇒ rendered disabled with the reason", /<button[^>]* disabled=""[^>]*data-customer-update-send/.test(blocked) && blocked.includes("data-customer-update-blocked"));
  check("blocked ⇒ the reauth notice line", blocked.includes("Reconnect request already sent 3 h ago (notice sent).") && blocked.includes("No update can be sent until 24 h after it"));
  const ro = render({ model: model({ sendEnabled: true, blockedBy: [] }), canWrite: false });
  check("read-only ⇒ no send, no preview, says why", !ro.includes("data-customer-update-send") && !ro.includes("data-customer-update-preview-btn") && ro.includes("Preview requires write access."));
  const bad = render({ model: model({ sendEnabled: true, blockedBy: [] }), paragraph: "Visit example.com" });
  check("lint fails ⇒ inline plain language, send + preview disabled", bad.includes("data-customer-update-lint") && bad.includes(LINT_MESSAGE.LINK.replace(/'/g, "&#x27;"))
    && /<button[^>]* disabled=""[^>]*data-customer-update-send/.test(bad) && /<button[^>]* disabled=""[^>]*data-customer-update-preview-btn/.test(bad));
  const sentM = render({ model: model({ dedupe: { episode: { sent: true, sentAt: hoursAgo(2) }, reauthNotice: null } }) });
  check("episode used ⇒ 'An update was already sent for this incident'", sentM.includes("An update was already sent for this incident."));
  const outcome = render({ outcome: sendOutcomeText(200, { outcome: "not_delivered_preference" }) });
  check("outcome rendered, including the preference case", outcome.includes("data-customer-update-outcome") && outcome.includes("not delivered (customer preference)"));
}

// ── 3. CS tier only ──────────────────────────────────────────────────────────
console.log("\n3. CS tier only (never Ops)");
{
  const dto = (tier: "ops" | "cs") => ({ tier, incident: { id: "inc_cu_1" }, affected: { institution: "Example Bank" } }) as unknown as IncidentDetailDTO;
  check("customerMessageSlot: ops ⇒ undefined", customerMessageSlot("ops", dto("ops"), true) === undefined);
  check("customerMessageSlot: ops tier with a cs DTO (or vice versa) ⇒ undefined", customerMessageSlot("ops", dto("cs"), true) === undefined && customerMessageSlot("cs", dto("ops"), true) === undefined);
  check("customerMessageSlot: cs ⇒ the section", customerMessageSlot("cs", dto("cs"), true) !== undefined);
  check("IncidentCustomerUpdate: ops DTO renders nothing", renderToStaticMarkup(createElement(IncidentCustomerUpdate, { d: dto("ops"), canWrite: true })) === "");
  const cs = renderToStaticMarkup(createElement(IncidentCustomerUpdate, { d: dto("cs"), canWrite: true }));
  check("IncidentCustomerUpdate: cs DTO renders the collapsed section", cs.includes("data-customer-update") && cs.includes("Customer update") && !/<details[^>]*\sopen/.test(cs));
  const lead = readFileSync("components/platform/incidents/IncidentsLead.tsx", "utf8");
  check("drawer passes the slot only through customerMessageSlot(tier, …)", /customerMessage: customerMessageSlot\(tier, data, canWrite\)/.test(lead) && (lead.match(/<IncidentCustomerUpdate\b/g) ?? []).length === 1);
  check("the section calls CS routes only", !/platform-ops/.test(readFileSync("components/platform/incidents/customer-update-model.ts", "utf8")));
  // The Ops drawer with no slot: nothing renders (the existing contract).
  const minimalOps = { ...dto("ops") };
  check("Ops surface fixture carries no customer-update slot", customerMessageSlot("ops", minimalOps, true) === undefined && typeof IncidentDetailSurface === "function");
}

// ── 4. no recipient identity ─────────────────────────────────────────────────
console.log("\n4. no recipient email or name");
{
  const all = [
    render(), render({ model: model({ sendEnabled: true, blockedBy: [] }) }),
    render({ preview: { message: renderIncidentCustomerUpdate({ paragraph: DRAFTS.investigate }), lint: { ok: true, codes: [], length: 1, max: 600 }, paragraphHash: "b".repeat(64), edited: false, sendEnabled: false } }),
  ].join("\n");
  check("no email address in any render", !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(all) && !all.includes(FAKE_EMAIL));
  check("no fake name / user id in any render", !all.includes(FAKE_NAME) && !all.includes(FAKE_USER_ID));
  const src = readFileSync("components/platform/incidents/CustomerUpdateSection.tsx", "utf8") + readFileSync("components/platform/incidents/customer-update-model.ts", "utf8");
  check("source reads no identity field (email / name / subjectUserId / subjectRef)", !/\.(email|name|displayName|firstName|lastName|subjectUserId|subjectRef)\b/.test(src));
  check("send body carries no recipient (paragraph, reason, expectedDraftHash only)", /JSON\.stringify\(\{ paragraph, reason, expectedDraftHash: model\.draft\.draftHash \}\)/.test(src));
}

// ── 5. preview + confirm ─────────────────────────────────────────────────────
console.log("\n5. preview + confirm");
{
  const msg = renderIncidentCustomerUpdate({ paragraph: DRAFTS.investigate });
  const html = render({ preview: { message: msg, lint: { ok: true, codes: [], length: 1, max: 600 }, paragraphHash: "b".repeat(64), edited: false, sendEnabled: false } });
  check("preview shows the full message (title, opening, paragraph, closing) and says nothing is sent",
    html.includes("data-customer-update-rendered") && html.includes("Preview · nothing is sent") && html.includes(INCIDENT_UPDATE_TITLE)
    && html.includes(INCIDENT_UPDATE_OPENING) && html.includes(DRAFTS.investigate.replace(/'/g, "&#x27;")) && html.includes(INCIDENT_UPDATE_CLOSING));
  const frame = render();
  check("fixed frame shown read-only around the textarea", frame.indexOf("data-template-opening") < frame.indexOf("data-customer-update-paragraph")
    && frame.indexOf("data-customer-update-paragraph") < frame.indexOf("data-template-closing") && (frame.match(/<textarea/g) ?? []).length === 1);
  check("counter rendered", frame.includes(`${DRAFTS["server-retry"].length} of ${INCIDENT_UPDATE_PARAGRAPH_MAX}`));
  check("delivery status list in words", frame.includes("Delivery status") && frame.includes("In-app · Not sent (customer preference)"));
  check("confirm copy says 'Sends this in-app message to the customer'", SEND_CONFIRM_MESSAGE.startsWith("Sends this in-app message to the customer"));
  const src = readFileSync("components/platform/incidents/CustomerUpdateSection.tsx", "utf8");
  check("confirm requires a reason and only exists when sendEnabled === true",
    /confirmDisabled=\{reasonPayload\(why\) === null\}/.test(src) && /confirming && model\?\.sendEnabled === true &&/.test(src) && src.includes("SEND_CONFIRM_MESSAGE"));
  check("collapsed by default (open only via the test hook)", /open=\{p\.open \|\| undefined\}/.test(src));
}

if (failures > 0) { console.error(`\n${failures} check(s) FAILED`); process.exit(1); }
console.log("\nAll customer-update section checks passed.");
