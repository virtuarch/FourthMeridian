/**
 * components/platform/comms/content-editor.test.ts  (Customer Success — Communications Center › content editor)
 *
 * The content editor's pure model and its static render, against Session 1's
 * REAL B1 vocabulary: the versions payload comes from the merged handler
 * (versionsList, over stub services — no DB), issues from the merged
 * validator, placeholders and limits from the merged leg specs.
 *
 *   1. fields + issue placement (parity with the server's fieldsOf / limits)
 *   2. placeholders: picker filter by allowedIn, insertion at the cursor
 *   3. structure: what may be added / removed / moved (manual §2.2 rules)
 *   4. controls from the viewer block and the leg lock
 *   5. drafts: a CONFLICT keeps the operator's text; rebase; AI accept / discard
 *   6. diffs, notes, expiry; AI-unavailable copy
 *   7. static render: locked / read-only / editable; the drawer's trigger + content
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/comms/content-editor.test.ts
 */

import "@/lib/test-support/route-env";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { versionsList, type ContentServices } from "@/lib/notifications/content/http";
import { LIMITS, legSpec, placeholderViews } from "@/lib/notifications/content/legs";
import { fieldsOf, validateContent } from "@/lib/notifications/content/validate";
import { CODE_DEFAULT_ID } from "@/lib/notifications/content/store";
import { catalogDetail } from "@/lib/notifications/catalog/http";
import type { AiSuggestResult, ContentBody, ContentIssue, TemplateVersionDTO, VersionsResponse, Viewer } from "@/lib/notifications/content/types";
import type { CatalogDetail } from "@/lib/notifications/catalog/types";
import { CODE_DEFAULT_VERSION_ID, type CommsReadResult } from "@/lib/platform/comms-center/client";
import type { CommsRead } from "./comms-kit";
import {
  CONTENT_CONFLICT_TEXT, FIXED_LIMITS, LOCK_TEXT, VIEWER_WHY,
  acceptSuggestion, addBlock, aiRemainingText, aiUnavailableText, canAddBlock, canMoveBlock, canRemoveBlock, changeRows, charCount, diffBodies, discardSuggestion,
  draftFrom, editBlock, editDraft, editorControls, editorFields, expiryText, fieldKey, insertToken, insertablePlaceholders, issueGate, legOptions, linkPlaceholders,
  locationLabel, moveBlock, notesByCategory, placeIssues, rebaseDraft, removeBlock, setField, saveOutcome, stateAfterLiveChange, stateAfterSave, writeRefusalText,
  aiAcceptWhy, guardDiscard, type ControlFacts, type EditorState,
} from "./content-model";
import { ContentEditor, ContentPanel } from "./ContentEditor";
import { CatalogDetailBody } from "./LibraryView";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ""}`); }
}
const count = (html: string, needle: string) => html.split(needle).length - 1;
const NOW = new Date("2026-10-31T12:00:00.000Z");

const ADMIN = { user: { id: "op_admin", role: "SYSTEM_ADMIN" }, grant: null };
const READ = { user: { id: "op_read", role: "USER" }, grant: { area: "CUSTOMER_SUCCESS", level: "READ" } };

/** Stub services: an unsaved stream (code default live), AI available with 37 calls left. */
function services(ai: Partial<{ paused: boolean; frozen: boolean }> = {}): ContentServices {
  return {
    readStream: async () => null, listVersionRows: async () => [], readVersion: async () => null, readHeads: async () => [], liveVersionNumber: async () => null,
    saveDraft: async () => { throw new Error("unused"); }, publishVersion: async () => { throw new Error("unused"); }, rollbackVersion: async () => { throw new Error("unused"); },
    recordSuggestion: async () => "x", readSelf: async () => ({ email: "op@example.invalid", verified: true }),
    env: { NODE_ENV: "test" } as never,
    ai: {
      admission: async () => ({ paused: ai.paused ?? false, state: "OFF", raw: null, cause: ai.paused ? "MAINTENANCE" : null }) as never,
      freeze: async () => ({ frozen: ai.frozen ?? false, state: ai.frozen ? "ON" : "OFF" }) as never,
      readAllowance: async () => ({ allowed: true, detail: "OK", remainingCalls: 37, remainingUsd: 1.5 }) as never,
      reserve: async () => { throw new Error("unused"); }, call: async () => { throw new Error("unused"); }, newId: () => "s1",
    },
  };
}

type TestAuth = { user: { id: string; role: string }; grant: { area: string; level: string } | null };
async function versionsFor(key: string, channel: string | null, variant: string | null, auth: TestAuth = ADMIN, ai?: Partial<{ paused: boolean; frozen: boolean }>): Promise<VersionsResponse> {
  const u = new URL(`http://x/versions?${[channel ? `channel=${channel}` : "", variant ? `variant=${variant}` : ""].filter(Boolean).join("&")}`);
  const r = await versionsList(key, u, auth as never, NOW, services(ai));
  if (r.status !== 200) throw new Error(`versionsList ${key} ${r.status} ${await r.text()}`);
  return (await r.json()) as VersionsResponse;
}

const FULL: Viewer = {
  canEditContent: true, canPublish: true, canRollback: true, canAiSuggest: true, canTestSend: true, canEditAutomation: true, canDryRun: true,
  canActivate: true, canApproveAsOwner: false, canPauseDisable: true, testSendEligible: true, testSendIneligibleReason: null,
};
const NONE: Viewer = { ...FULL, canEditContent: false, canPublish: false, canRollback: false, canAiSuggest: false };

function version(over: Partial<TemplateVersionDTO> & { body?: ContentBody }): TemplateVersionDTO {
  const b = over.body ?? { subject: "S", preheader: null, blocks: [] };
  return {
    id: "v1", version: 1, state: "DRAFT", subject: b.subject, preheader: b.preheader, blocks: b.blocks, placeholdersUsed: [],
    createdBy: { kind: "OPERATOR", actorKind: "PLATFORM_OPERATOR" }, createdAt: NOW.toISOString(), publishedAt: null, auditLogId: "a1", revision: 1,
    stream: { definitionKey: "SYNC_FAILED", channel: "EMAIL", variant: "sync-failed" }, publishAuditLogId: null, parentVersionId: null,
    basePublishedVersionId: null, restoredFromVersionId: null, sourceSuggestionId: null, aiEditedAfterAccept: null, issues: [], ...over,
  };
}

async function main() {
  const email = await versionsFor("SYNC_FAILED", "EMAIL", "sync-failed");
  const inApp = await versionsFor("SYNC_FAILED", "IN_APP", "sync-failed");
  const emailSpec = legSpec("SYNC_FAILED", "EMAIL")!;
  const inAppSpec = legSpec("SYNC_FAILED", "IN_APP")!;
  const codeEmail: ContentBody = { subject: email.codeDefault.subject, preheader: email.codeDefault.preheader, blocks: email.codeDefault.blocks };
  const codeInApp: ContentBody = { subject: inApp.codeDefault.subject, preheader: inApp.codeDefault.preheader, blocks: inApp.codeDefault.blocks };

  console.log("0. the real versions payload (merged handler, stub services)");
  {
    check("SYNC_FAILED/EMAIL: editable, code default live, revision 0, no versions", email.contentEditable && email.locked === null && email.live.source === "CODE_DEFAULT" && email.revision === 0 && email.items.length === 0);
    check("ai block: available with remaining calls", email.ai.available && email.ai.remainingCallsToday === 37 && aiRemainingText(email.ai) === "37 AI calls left today");
    check("placeholders carry no source / pii (client view)", email.placeholders.every((p) => !("source" in p) && !("pii" in p)));
    const locked = await versionsFor("SPACE_INVITE_RECEIVED", "EMAIL", null);
    check("the space-invite ceremony email leg reads 200 with locked PROTECTED", !locked.contentEditable && locked.locked?.reason === "PROTECTED");
    check("the reserved rollback id is the server's", CODE_DEFAULT_VERSION_ID === CODE_DEFAULT_ID);
  }

  console.log("1. fields and issue placement");
  {
    const keys = (b: ContentBody, ch: "EMAIL" | "IN_APP") => editorFields(b, ch, ch === "EMAIL" ? email.limits : inApp.limits).map((f) => `${f.key}:${f.max}:${f.where}`).join("|");
    const serverKeys = (b: ContentBody, ch: "EMAIL" | "IN_APP") => fieldsOf(b, ch).map((f) => `${fieldKey(f.location)}:${f.max}:${f.where}`).join("|");
    const rich: ContentBody = {
      subject: "s", preheader: "p",
      blocks: [{ kind: "hero", heading: "h", greeting: "g" }, { kind: "paragraph", text: "t" }, { kind: "info", title: "T", items: ["a", "b"] }, { kind: "divider" }, { kind: "cta", label: "c", link: "actionUrl" }],
    };
    check("editor fields == the server's fieldsOf (keys, maxima, allowedIn class) — EMAIL, every block kind", keys(rich, "EMAIL") === serverKeys(rich, "EMAIL"), [keys(rich, "EMAIL"), serverKeys(rich, "EMAIL")]);
    check("editor fields == the server's fieldsOf — IN_APP code default", keys(codeInApp, "IN_APP") === serverKeys(codeInApp, "IN_APP"));
    check("the fixed §2.2 limits match the server's LIMITS", FIXED_LIMITS.heading === LIMITS.EMAIL.heading && FIXED_LIMITS.infoItem === LIMITS.EMAIL.infoItem
      && FIXED_LIMITS.infoTitle === LIMITS.EMAIL.infoTitle && FIXED_LIMITS.infoItems === LIMITS.EMAIL.infoItems);
    check("locations label in operator words", locationLabel({ field: "block", blockIndex: 2, prop: "items", itemIndex: 1 }, rich) === "Block 3 · List item 2"
      && locationLabel({ field: "block", blockIndex: 1, prop: "text" }, rich) === "Block 2 · Paragraph text" && locationLabel(null) === "Whole message");

    // A broken email: long subject, an unknown placeholder in the paragraph, a hero out of order, a CTA to a TEXT name, no required subject name.
    const broken: ContentBody = {
      subject: "x".repeat(130), preheader: "Hello",
      blocks: [{ kind: "paragraph", text: "Hi {{nope}}" }, { kind: "hero", heading: "Late" }, { kind: "cta", label: "Go", link: "institutionName" }],
    };
    const issues = validateContent(emailSpec, broken, { mode: "manual", baseline: codeEmail, variant: "sync-failed" });
    const placed = placeIssues(issues, broken, "EMAIL", email.limits);
    const codes = (xs: ContentIssue[] | undefined) => (xs ?? []).map((i) => i.code).sort().join();
    check("FIELD_TOO_LONG and REQUIRED_PLACEHOLDER_MISSING land on the subject", /FIELD_TOO_LONG/.test(codes(placed.field.subject)) && /REQUIRED_PLACEHOLDER_MISSING/.test(codes(placed.field.subject)), placed.field.subject);
    check("UNKNOWN_PLACEHOLDER lands on block 1's text", /UNKNOWN_PLACEHOLDER/.test(codes(placed.field["b0.text"])));
    check("BLOCK_ORDER lands on the misplaced hero's heading", /BLOCK_ORDER/.test(codes(placed.field["b1.heading"])));
    check("a CTA to a TEXT placeholder lands on the link select", /PLACEHOLDER_KIND_MISMATCH/.test(codes(placed.field["b2.link"])));
    check("the template-level required-button issue goes on top", placed.top.some((i) => i.code === "REQUIRED_PLACEHOLDER_MISSING" && i.location === null));
    const total = placed.top.length + Object.values(placed.field).flat().length + Object.values(placed.block).flat().length;
    check("every issue is placed exactly once", total === issues.length, { total, n: issues.length });
    const stale = placeIssues([{ code: "FIELD_TOO_LONG", severity: "error", location: { field: "block", blockIndex: 9, prop: "text" }, message: "m" }], broken, "EMAIL", email.limits);
    check("an issue for a block that no longer exists goes on top (never lost)", stale.top.length === 1);
    const listIssue = placeIssues([{ code: "TOO_MANY_ITEMS", severity: "error", location: { field: "block", blockIndex: 2, prop: "items" }, message: "m" }], rich, "EMAIL", email.limits);
    check("a list-level issue (items, no itemIndex) goes on the block", listIssue.block[2]?.length === 1);
    const sorted = placeIssues([{ code: "FINANCIAL_CLAIM", severity: "warning", location: { field: "subject" }, message: "w" }, { code: "EMPTY_FIELD", severity: "error", location: { field: "subject" }, message: "e" }], rich, "EMAIL", email.limits);
    check("errors before warnings within a slot", sorted.field.subject[0].severity === "error");

    const g = issueGate(issues);
    check("issue gate: errors block", g.blocks && g.errors > 0 && /error/.test(g.summary));
    const warn = issueGate([{ code: "ADVICE_LANGUAGE", severity: "warning", location: { field: "subject" }, message: "w" }]);
    check("issue gate: warnings alone don't block but need an acknowledgement", !warn.blocks && warn.needsAck && warn.summary === "1 warning");
    check("issue gate: clean", issueGate([]).summary === "No issues" && !issueGate([]).needsAck);
    check("char counter: over / near", charCount("x".repeat(121), 120).over && charCount("x".repeat(110), 120).near && charCount("abc", 120).text === "3 / 120");
    check("setField writes one field, immutably", (() => { const b = setField(rich, { field: "block", blockIndex: 2, prop: "items", itemIndex: 1 }, "B"); return b !== rich && (b.blocks[2] as { items: string[] }).items.join() === "a,B" && (rich.blocks[2] as { items: string[] }).items.join() === "a,b"; })());
    check("setField ignores a stale location", setField(rich, { field: "block", blockIndex: 99, prop: "text" }, "x") === rich && setField(codeInApp, { field: "preheader" }, "x") === codeInApp);
  }

  console.log("2. placeholders");
  {
    const views = placeholderViews(emailSpec);
    check("the picker offers TEXT names allowed in the focused field; LINK names never", insertablePlaceholders(views, "subject").map((p) => p.name).join() === "institutionName"
      && insertablePlaceholders(views, "cta").every((p) => p.kind === "TEXT") && !insertablePlaceholders(views, null).some((p) => p.kind === "LINK"));
    const restricted = [{ name: "a", kind: "TEXT" as const, allowedIn: ["body"] as const, maxLength: 10, fallback: "f", sample: "s" }, { name: "b", kind: "TEXT" as const, allowedIn: ["subject", "body"] as const, maxLength: 10, fallback: "f", sample: "s" }];
    check("allowedIn filters per field", insertablePlaceholders(restricted, "subject").map((p) => p.name).join() === "b" && insertablePlaceholders(restricted, "body").length === 2);
    check("the button link select lists LINK names only (EMAIL actionUrl, IN_APP inAppHref)", linkPlaceholders(views).map((p) => p.name).join() === "actionUrl"
      && linkPlaceholders(placeholderViews(inAppSpec)).map((p) => p.name).join() === "inAppHref");
    const ins = insertToken("Hello world", "institutionName", 6, 6);
    check("insert at the cursor; caret after the token", ins.value === "Hello {{institutionName}}world" && ins.caret === 6 + "{{institutionName}}".length);
    check("insert replaces a selection", insertToken("Hello world", "x", 6, 11).value === "Hello {{x}}");
    check("no cursor ⇒ append; out-of-range clamps", insertToken("ab", "x", null, null).value === "ab{{x}}" && insertToken("ab", "x", 99, 120).value === "ab{{x}}" && insertToken("ab", "x", -5, 1).value === "{{x}}b");
    const inserted = setField(codeEmail, { field: "subject" }, insertToken("Sync failed for ", "institutionName", 99, 99).value);
    check("an inserted token validates server-side (no placeholder issue)", !validateContent(emailSpec, inserted, { mode: "manual", baseline: codeEmail, variant: "sync-failed" }).some((i) => /PLACEHOLDER/.test(i.code)));
  }

  console.log("3. structure (manual drafts may add / remove / reorder within §2.2)");
  {
    const L = email.limits;
    check("EMAIL: one heading, one button; IN_APP: paragraph + button only, one of each",
      !canAddBlock(codeEmail, "EMAIL", "cta", L).ok && canAddBlock(codeEmail, "EMAIL", "info", L).ok && canAddBlock(codeEmail, "EMAIL", "divider", L).ok
        && !canAddBlock(codeInApp, "IN_APP", "hero", inApp.limits).ok && !canAddBlock(codeInApp, "IN_APP", "info", inApp.limits).ok);
    const hasHero = codeEmail.blocks.some((b) => b.kind === "hero");
    check("a heading is addable only when none exists", canAddBlock(codeEmail, "EMAIL", "hero", L).ok === !hasHero);
    const full: ContentBody = { ...codeEmail, blocks: Array.from({ length: L.blocks }, () => ({ kind: "divider" as const })) };
    check("the block cap", !canAddBlock(full, "EMAIL", "paragraph", L).ok && /At most 12/.test(canAddBlock(full, "EMAIL", "paragraph", L).why ?? ""));
    const noHero: ContentBody = { ...codeEmail, blocks: codeEmail.blocks.filter((b) => b.kind !== "hero") };
    const withHero = addBlock(noHero, "EMAIL", "hero", email.placeholders);
    check("a new heading goes first", withHero.blocks[0].kind === "hero");
    const inAppEmpty: ContentBody = { subject: "t", preheader: null, blocks: [{ kind: "cta", label: "Go", link: "inAppHref" }] };
    const ip = addBlock(inAppEmpty, "IN_APP", "paragraph", inApp.placeholders);
    check("an in-app paragraph goes before the button", ip.blocks.map((b) => b.kind).join() === "paragraph,cta");
    const noCta: ContentBody = { ...codeEmail, blocks: codeEmail.blocks.filter((b) => b.kind !== "cta") };
    const cta = addBlock(noCta, "EMAIL", "cta", email.placeholders);
    check("a new button defaults to the template's link placeholder", (cta.blocks[cta.blocks.length - 1] as { link: string }).link === "actionUrl");
    // Parity: every add the model allows is structurally accepted by the server validator.
    const structural = /BLOCK_KIND_NOT_ALLOWED|BLOCK_ORDER|TOO_MANY_BLOCKS|EMPTY_CONTENT/;
    for (const k of ["paragraph", "info", "divider"] as const) {
      const b = addBlock(codeEmail, "EMAIL", k, email.placeholders);
      const filled = k === "paragraph" ? setField(b, { field: "block", blockIndex: b.blocks.length - 1, prop: "text" }, "More detail.")
        : k === "info" ? setField(b, { field: "block", blockIndex: b.blocks.length - 1, prop: "items", itemIndex: 0 }, "A step.") : b;
      const iss = validateContent(emailSpec, filled, { mode: "manual", baseline: codeEmail, variant: "sync-failed" });
      check(`adding a ${k} block is structurally valid server-side`, !iss.some((i) => structural.test(i.code)), iss);
    }
    const moved = moveBlock(withHero, 1, -1);
    check("nothing moves above the heading; the heading never moves", moved === withHero && !canMoveBlock(withHero, 0, 1).ok && !canMoveBlock(withHero, 1, -1).ok);
    const twoParas: ContentBody = { subject: "s", preheader: "p", blocks: [{ kind: "paragraph", text: "a" }, { kind: "paragraph", text: "b" }] };
    check("other blocks reorder", moveBlock(twoParas, 0, 1).blocks.map((b) => (b as { text: string }).text).join() === "b,a");
    const one: ContentBody = { subject: "s", preheader: "p", blocks: [{ kind: "paragraph", text: "a" }] };
    check("an email keeps ≥ 1 block; in-app may be empty", !canRemoveBlock(one, "EMAIL", 0).ok && canRemoveBlock(inAppEmpty, "IN_APP", 0).ok && removeBlock(twoParas, 0).blocks.length === 1);
    const info: ContentBody = { subject: "s", preheader: "p", blocks: [{ kind: "info", items: ["a"] }] };
    const items8 = Array.from({ length: 8 }, (_, i) => `i${i}`);
    check("list items: add up to 8, keep ≥ 1; optional title / ordered toggle",
      (editBlock(info, 0, "add-item").blocks[0] as { items: string[] }).items.length === 2
        && (editBlock({ ...info, blocks: [{ kind: "info", items: items8 }] }, 0, "add-item").blocks[0] as { items: string[] }).items.length === 8
        && editBlock(info, 0, "remove-item", 0) === info
        && (editBlock(info, 0, "toggle-title").blocks[0] as { title?: string }).title === ""
        && !("title" in editBlock(editBlock(info, 0, "toggle-title"), 0, "toggle-title").blocks[0])
        && (editBlock(info, 0, "toggle-ordered").blocks[0] as { ordered?: boolean }).ordered === true);
  }

  console.log("4. controls from the viewer block and the lock");
  {
    const facts = (over: Partial<ControlFacts>): ControlFacts => ({
      viewer: FULL, locked: null, contentEditable: true, ai: email.ai, dirty: false, blockingErrors: false, conflict: false,
      base: { id: "v1", state: "DRAFT" }, suggestionExpired: false, hasRollbackTarget: true, ...over,
    });
    const locked = editorControls(facts({ locked: { reason: "PROTECTED" }, contentEditable: false }));
    check("a locked leg: the reason, and NO editing control at all", locked.locked === LOCK_TEXT.PROTECTED && [locked.edit, locked.save, locked.publish, locked.rollback, locked.ai].every((c) => !c.shown));
    check("NOT_EDITABLE lock text", editorControls(facts({ locked: { reason: "NOT_EDITABLE" } })).locked === LOCK_TEXT.NOT_EDITABLE);
    const ro = editorControls(facts({ viewer: NONE }));
    check("a view-only viewer: every control disabled with one line why (no permission level named)",
      !ro.edit.enabled && ro.edit.why === VIEWER_WHY.edit && ro.publish.why === VIEWER_WHY.publish && ro.rollback.why === VIEWER_WHY.rollback && ro.ai.why === VIEWER_WHY.ai
        && [ro.edit, ro.save, ro.publish, ro.rollback, ro.ai].every((c) => c.shown && !/WRITE|READ\b|level/i.test(c.why ?? "")));
    check("nothing to restore ⇒ that reason instead", editorControls(facts({ viewer: NONE, hasRollbackTarget: false })).rollback.why === VIEWER_WHY.rollbackNoTarget);
    const dirtyErr = editorControls(facts({ dirty: true, blockingErrors: true }));
    check("errors block Save; a dirty editor blocks Publish and AI", !dirtyErr.save.enabled && /errors/.test(dirtyErr.save.why ?? "") && !dirtyErr.publish.enabled && !dirtyErr.ai.enabled);
    check("Save is on for a dirty, clean-checked draft", editorControls(facts({ dirty: true })).save.enabled);
    check("an unresolved CONFLICT blocks Save until reload", /Reload/.test(editorControls(facts({ dirty: true, conflict: true })).save.why ?? ""));
    check("an expired suggestion blocks Save", /expired/.test(editorControls(facts({ dirty: true, suggestionExpired: true })).save.why ?? ""));
    check("Publish only from a saved DRAFT", editorControls(facts({})).publish.enabled && !editorControls(facts({ base: { id: "v1", state: "PUBLISHED" } })).publish.enabled && !editorControls(facts({ base: null })).publish.enabled);
    check("AI needs a saved base", !editorControls(facts({ base: null })).ai.enabled && editorControls(facts({})).ai.enabled);
    const frozen = await versionsFor("SYNC_FAILED", "EMAIL", "sync-failed", ADMIN, { frozen: true });
    const aiOff = editorControls(facts({ ai: frozen.ai }));
    check("AI unavailable (real COST_FREEZE block) ⇒ the plain-English reason, manual editing still on", !aiOff.ai.enabled && /cost freeze/.test(aiOff.ai.why ?? "") && aiOff.edit.enabled);
    const readOnlyPayload = await versionsFor("SYNC_FAILED", "EMAIL", "sync-failed", READ);
    check("the real viewer block for a CS READ grant: no edit, publish, restore or AI", !readOnlyPayload.viewer.canEditContent && !readOnlyPayload.viewer.canPublish && !readOnlyPayload.viewer.canAiSuggest && !readOnlyPayload.viewer.canRollback);
  }

  console.log("5. drafts: conflict keeps the text; rebase; AI accept / discard");
  {
    const d0 = draftFrom(codeEmail, null, 3);
    const typed = editDraft(d0, setField(codeEmail, { field: "subject" }, "My unsaved subject {{institutionName}}"));
    const conflict: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "error", status: 409, code: "CONFLICT", error: "Stale.", current: 5 };
    const st: EditorState = { draft: typed, base: null };
    const sent = typed.body;
    // The operator kept typing while the request was in flight: `prev` at resolution differs from what was sent.
    const later: EditorState = { ...st, draft: editDraft(typed, setField(typed.body, { field: "subject" }, "Typed DURING the save {{institutionName}}")) };
    const c = saveOutcome(conflict);
    check("409 CONFLICT outcome: current token, conflict copy", c.kind === "conflict" && c.current === 5 && c.notice === CONTENT_CONFLICT_TEXT);
    check("409 CONFLICT: the state AT RESOLUTION is kept (text typed in flight survives)", stateAfterSave(later, sent, conflict) === later);
    const rebased = rebaseDraft(typed, { revision: 5 });
    check("reload ⇒ rebase: same text, new expectedRevision", rebased.body === typed.body && rebased.revision === 5 && rebased.dirty);
    const rebasedOld = rebaseDraft({ ...typed, parentVersionId: "v1-not-on-page-1" }, { revision: 6 });
    check("rebase keeps the parent even when it is not on the first page (versions are never deleted)", rebasedOld.parentVersionId === "v1-not-on-page-1");
    const issues: ContentIssue[] = [{ code: "EMPTY_FIELD", severity: "error", location: { field: "subject" }, message: "empty" }];
    const invalid: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "error", status: 400, code: "CONTENT_INVALID", error: "x", issues };
    const inv = saveOutcome(invalid);
    check("400 CONTENT_INVALID: issues carried; state kept", inv.kind === "invalid" && inv.issues === issues && stateAfterSave(later, sent, invalid) === later);
    const deniedR: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "denied", status: 403, code: "OPERATOR_TOTP_REQUIRED", error: "Two-factor verification is required for operator access." };
    const denied = saveOutcome(deniedR);
    check("403 fresh-auth / TOTP: the house denied copy; state kept", denied.kind === "refused" && /Two-factor/.test(denied.notice) && stateAfterSave(later, sent, deniedR) === later);
    const netR: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "error", status: 0, code: null, error: "Network error — the request did not complete." };
    check("network failure: state kept", stateAfterSave(later, sent, netR) === later);
    const okR: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "ok", data: { result: version({ id: "v7", version: 7, revision: 6, body: typed.body }) } };
    const savedState = stateAfterSave(st, sent, okR);
    check("saved, nothing typed since: clean draft on the new version and revision", !savedState.draft.dirty && savedState.draft.parentVersionId === "v7" && savedState.draft.revision === 6 && savedState.base?.id === "v7" && /v7/.test(saveOutcome(okR).notice));
    const savedTyped = stateAfterSave(later, sent, okR);
    check("saved, but the operator typed since: THEIR text stays, dirty, now on v7 / revision 6", savedTyped.draft.body === later.draft.body && savedTyped.draft.dirty
      && savedTyped.draft.parentVersionId === "v7" && savedTyped.draft.revision === 6 && savedTyped.draft.source.kind === "MANUAL" && savedTyped.base?.id === "v7");
    const pub = version({ id: "v8", version: 8, state: "PUBLISHED", revision: 7, body: codeEmail });
    const liveClean = stateAfterLiveChange(savedState, { revision: 7, published: pub, body: codeEmail });
    check("publish / restore with a clean editor: the editor moves to the live version", !liveClean.draft.dirty && liveClean.draft.parentVersionId === "v8" && liveClean.base?.id === "v8" && liveClean.draft.revision === 7);
    const liveDirty = stateAfterLiveChange(later, { revision: 7, published: null, body: codeEmail });
    check("publish / restore never clobbers a dirty draft (text, parent and base kept; revision moves)", liveDirty.draft.body === later.draft.body && liveDirty.draft.dirty
      && liveDirty.draft.parentVersionId === later.draft.parentVersionId && liveDirty.base === later.base && liveDirty.draft.revision === 7);
    const saved = { draft: savedState.draft };
    const sug: AiSuggestResult = {
      suggestionId: "sg1", baseVersionId: "v7", mode: "POLISH", base: typed.body, suggestion: setField(typed.body, { field: "subject" }, "Polished {{institutionName}}"),
      changes: [{ location: { field: "subject" }, before: typed.body.subject, after: "Polished {{institutionName}}" }],
      notes: [{ location: { field: "subject" }, category: "TONE", text: "Friendlier." }, { location: null, category: "GRAMMAR", text: "Fixed a comma." }],
      checks: { structurePreserved: true, placeholdersPreserved: true, linksAdded: false, financialClaimsAdded: false, adviceAdded: false },
      model: "m", expiresAt: "2026-11-01T12:00:00.000Z", checkedAt: NOW.toISOString(),
    };
    const acc = acceptSuggestion(saved.draft, sug);
    check("accept: an UNSAVED draft from the suggestion, source AI_SUGGESTION, parent = the suggestion's base", acc.dirty && acc.body === sug.suggestion && acc.source.kind === "AI_SUGGESTION"
      && acc.source.suggestionId === "sg1" && acc.parentVersionId === "v7");
    const back = discardSuggestion(acc);
    check("discard: back to the operator's text, MANUAL", back.body === saved.draft.body && back.source.kind === "MANUAL" && !back.dirty);
    const expR: CommsReadResult<{ result: TemplateVersionDTO }> = { kind: "error", status: 409, code: "SUGGESTION_EXPIRED", error: "x" };
    const exp = saveOutcome(expR);
    const accState: EditorState = { draft: acc, base: null };
    check("SUGGESTION_EXPIRED: text kept, flagged expired", exp.kind === "refused" && exp.expired === true && stateAfterSave(accState, acc.body, expR) === accState);
    const v7 = version({ id: "v7", version: 7 });
    check("AI accept: off when nothing changed / expired / unsaved edits / the editor moved to another version",
      aiAcceptWhy(sug, v7, null, false) === null && aiAcceptWhy({ ...sug, changes: [] }, v7, null, false) !== null && /expired/.test(aiAcceptWhy(sug, v7, null, true) ?? "")
        && aiAcceptWhy(sug, v7, "Save first.", false) === "Save first." && /another version/.test(aiAcceptWhy(sug, version({ id: "v9" }), null, false) ?? ""));
    check("AI 503 retry-after shown in the refusal", /Try again in about 60 min/.test(writeRefusalText({ kind: "unavailable", error: "x", ai: { reason: "ALLOWANCE", detail: "EXHAUSTED", retryAfterSeconds: 3600 } })));
    check("discard guard: asks only when dirty", guardDiscard(false, () => false) && !guardDiscard(true, () => false) && guardDiscard(true, () => true));

    console.log("6. diffs, notes, expiry, AI copy");
    const rows = changeRows(sug);
    check("AI changes → labelled before/after rows", rows.length === 1 && rows[0].label === "Subject" && rows[0].after === "Polished {{institutionName}}");
    const groups = notesByCategory(sug.notes, sug.base);
    check("notes grouped in category order with locations", groups.map((g) => g.label).join() === "Grammar,Tone" && groups[0].notes[0].where === "Whole message");
    const d = diffBodies(codeEmail, setField(codeEmail, { field: "subject" }, "Changed"));
    check("diff: only changed fields", d.length === 1 && d[0].key === "subject" && d[0].before === codeEmail.subject && d[0].after === "Changed");
    const added = diffBodies(codeEmail, addBlock(codeEmail, "EMAIL", "divider", email.placeholders));
    check("diff: an added block shows as a block row with no 'before'", added.some((r) => r.before === null && r.after === "Divider"));
    check("diff: identical ⇒ empty", diffBodies(codeEmail, { ...codeEmail }).length === 0);
    check("expiry: minutes / hours / expired", expiryText("2026-10-31T12:30:00.000Z", NOW.getTime()).text === "Expires in 30 min"
      && expiryText("2026-11-01T12:00:00.000Z", NOW.getTime()).text === "Expires in 24 h" && expiryText("2026-10-31T11:00:00.000Z", NOW.getTime()).expired);
    for (const [reason, detail, re] of [["KILL_SWITCH", "KILL_SWITCH", /paused/], ["KILL_SWITCH", "MAINTENANCE", /maintenance/], ["COST_FREEZE", "FROZEN", /cost freeze is on/],
      ["COST_FREEZE", "UNVERIFIED", /couldn’t be verified/], ["ALLOWANCE", "EXHAUSTED", /00:00 UTC/], ["PROVIDER", "TIMEOUT", /timed out/], ["PROVIDER", "WHATEVER", /call failed/]] as const) {
      const t = aiUnavailableText(reason, detail);
      check(`AI unavailable ${reason}/${detail}: plain English, honest`, re.test(t) && !/_/.test(t), t);
    }
    check("gate reasons say manual editing still works; PROVIDER says nothing changed", /Manual editing still works/.test(aiUnavailableText("ALLOWANCE", null)) && /Nothing was changed/.test(aiUnavailableText("PROVIDER", null)));
    check("refusal copy: STALE_DRAFT / WARNINGS_UNACKNOWLEDGED / 503 AI", /published since/.test(writeRefusalText({ kind: "error", status: 409, code: "STALE_DRAFT", error: "x" }))
      && /acknowledgement/.test(writeRefusalText({ kind: "error", status: 409, code: "WARNINGS_UNACKNOWLEDGED", error: "x" }))
      && /cost freeze/.test(writeRefusalText({ kind: "unavailable", error: "x", ai: { reason: "COST_FREEZE", detail: "FROZEN", retryAfterSeconds: null } })));
  }

  console.log("7. static render");
  {
    const base = { itemKey: "SYNC_FAILED", channel: "EMAIL" as const, variant: "sync-failed", refreshing: false, onReload: () => {} };
    const ed = renderToStaticMarkup(createElement(ContentEditor, { ...base, data: email }));
    check("editable: the editor, Save draft, the placeholder picker, the live check", ed.includes('data-content-editor="editable"') && ed.includes("data-save-draft") && ed.includes('data-insert="institutionName"') && ed.includes("data-check-now"));
    check("the button link is a select of LINK names — no free URL input", ed.includes("data-cta-link") && /<select[^>]*data-cta-link[^>]*>[\s\S]*?\{\{actionUrl\}\}[\s\S]*?<\/select>/.test(ed) && !/type="url"/.test(ed));
    check("LINK names are never offered for insertion", !ed.includes('data-insert="actionUrl"'));
    check("char counters on every field", count(ed, "data-char-count") === editorFields(codeEmail, "EMAIL", email.limits).length);
    check("no unsaved changes ⇒ Save is disabled; publish explains why", /<button[^>]*disabled=""[^>]*data-save-draft/.test(ed) && ed.includes("Open a saved draft to publish it."));
    check("AI: available with the remaining calls; disabled until a draft is saved", ed.includes("37 AI calls left today") && ed.includes("Save a draft first"));
    check("version history: nothing saved, code default live", ed.includes("Nothing saved yet") && ed.includes("Live: Code default"));
    check("mobile: no fixed widths; wrapping containers", !/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]/.test(ed) && ed.includes("min-w-0") && ed.includes("flex-wrap"));
    check("no customer data: the editor shows placeholder SAMPLES only (synthetic)", ed.includes("Example Bank") && !/@(?!example\.invalid)[a-z0-9-]+\.[a-z]{2,}/i.test(ed));

    const locked = await versionsFor("SPACE_INVITE_RECEIVED", "EMAIL", null);
    const lk = renderToStaticMarkup(createElement(ContentEditor, { ...base, itemKey: "SPACE_INVITE_RECEIVED", variant: "default", data: locked }));
    check("locked: the PROTECTED reason and no input, select or editing button", lk.includes('data-content-locked="PROTECTED"') && !/<input|<textarea|<select/.test(lk) && !lk.includes("data-save-draft") && !lk.includes("data-publish"));

    const ro = renderToStaticMarkup(createElement(ContentEditor, { ...base, data: { ...email, viewer: NONE } }));
    check("view-only: fields read-only, no Save, no picker, the why line", /<input[^>]*readOnly=""/i.test(ro) || /<input[^>]*readonly=""/i.test(ro));
    check("view-only: no Save button, no placeholder insertion, no add-block", !ro.includes("data-save-draft") && !ro.includes("data-insert=") && !ro.includes("data-add-block") && ro.includes(VIEWER_WHY.edit));
    check("view-only: publish / AI shown disabled with why", ro.includes(VIEWER_WHY.publish) && ro.includes(VIEWER_WHY.ai));

    const withVersions: VersionsResponse = {
      ...email, viewer: FULL, revision: 4, live: { source: "PUBLISHED", versionId: "v3", version: 3 },
      items: [
        version({ id: "v4", version: 4, state: "DRAFT", createdBy: { kind: "AI_ASSISTED", actorKind: "PLATFORM_OPERATOR" }, aiEditedAfterAccept: true, body: codeEmail,
          issues: [{ code: "FINANCIAL_CLAIM", severity: "warning", location: { field: "subject" }, message: "Numbers." }] }),
        version({ id: "v3", version: 3, state: "PUBLISHED", publishedAt: NOW.toISOString(), body: codeEmail }),
        version({ id: "v2", version: 2, state: "SUPERSEDED", publishedAt: NOW.toISOString(), createdBy: { kind: "ROLLBACK", actorKind: "SYSTEM_ADMIN" }, restoredFromVersionId: "v1", body: codeEmail }),
      ],
    };
    const h = renderToStaticMarkup(createElement(ContentEditor, { ...base, data: withVersions }));
    check("history: state chips, created-by, AI-edited flag, warnings, dates", h.includes("Draft") && h.includes("Live") && h.includes("Superseded") && h.includes("AI-assisted")
      && h.includes("Edited after AI") && h.includes("1 warning") && h.includes("Restore of an earlier version") && h.includes("2026-10-31 12:00 UTC"));
    check("history: Restore only on the superseded version; Restore code default when a version is live", count(h, "Restore…") === 1 && h.includes("Restore code default…"));
    check("the editor starts from the live version (v3)", h.includes("from v3"));

    const legs = legOptions({ channels: [{ channel: "EMAIL" }, { channel: "IN_APP" }], content: [{ channel: "IN_APP", variants: ["default"], live: [{ variant: "default", source: "PUBLISHED", versionId: "x", version: 2 }] }] });
    check("leg options: the locked EMAIL leg is listed as locked, the editable leg with its live source", legs.map((l) => `${l.channel}:${l.editable}`).join() === "EMAIL:false,IN_APP:true" && legs[1].liveOf("default") === "Published v2");

    const plain = (await (await catalogDetail("PLATFORM_ACCESS_GRANTED", NOW)).json()) as CatalogDetail;
    const ok = <T,>(data: T): CommsRead<T> => ({ loading: false, result: { kind: "ok", data } });
    const dHtml = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(plain), preview: null }));
    check("drawer Trigger section lists additionalTriggerKeys", dHtml.includes("data-additional-triggers") && dHtml.includes("platform.grant.reinstated") && dHtml.includes("platform.grant.level_changed"));
    const banner = (await (await catalogDetail("SYNC_FAILED", NOW)).json()) as CatalogDetail;
    const noContent = renderToStaticMarkup(createElement(ContentPanel, { detail: banner }));
    check("a pre-v1.1 detail (no `content`) renders no Content section", noContent === "");
    const panel = renderToStaticMarkup(createElement(ContentPanel, { detail: { ...banner, content: [], contentLocked: true, viewer: NONE, channels: [] } }));
    check("a definition with no email / in-app leg: the lock note, no controls", panel.includes("data-content-locked") && !/<input|<textarea|<button/.test(panel));
    const withPanel = renderToStaticMarkup(createElement(CatalogDetailBody, { read: ok(banner), preview: null, content: createElement("p", null, "CONTENT-SLOT") }));
    check("the drawer renders a Content section when given one", withPanel.includes('aria-label="Content"') && withPanel.includes("CONTENT-SLOT"));
  }

  console.log("8. source rules (regressions of the review fixes)");
  {
    const { readFileSync } = await import("node:fs");
    const strip = (rel: string) => readFileSync(rel, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const ed = strip("components/platform/comms/ContentEditor.tsx");
    const panel = ed.slice(ed.indexOf("export function ContentPanel("), ed.indexOf("function LockedNote("));
    check("ContentPanel reads through useLastGoodRead (never okData ?? staleData)", /useLastGoodRead<VersionsResponse>/.test(panel) && !/staleData/.test(panel) && !/okData\(/.test(panel));
    check("ContentEditor owns no draft state: no setDraft / useState<Draft>; every write goes through ed.*",
      !/\bsetDraft\b|useState<Draft|useState<\s*\{\s*draft/.test(ed) && /ed\.save\(/.test(ed) && (ed.match(/ed\.liveChanged\(/g) ?? []).length === 1
        && /afterLiveChange\(`Published/.test(ed) && /onRestored=\{\(text, revision, published\) => afterLiveChange\(/.test(ed));
    check("postSaveDraft is called only inside ed.save", (ed.match(/postSaveDraft\(/g) ?? []).length === 1 && /ed\.save\(\(sent\) => postSaveDraft\(/.test(ed));
    check("the save notice uses the save's own typedSince (not a post-await state read)", /o\.typedSince/.test(ed) && !/ed\.latest\(\)\?\.draft\.dirty/.test(ed.slice(ed.indexOf("const save = async"), ed.indexOf("const openVersion"))));
    check("HistoryBox is not keyed by revision (open View / restore form survive a write)", !/<HistoryBox key=/.test(ed));
    const dash = strip("components/platform/PlatformSpaceDashboard.tsx");
    check("the dashboard's workspace and view switches ask the unsaved-content guard (re-selecting the active one never asks or clears it)",
      /const setActiveTab = useCallback\(\(id: string\) => \{ if \(id === activeTab \|\| confirmLeaveCommsContent\(\)\) setActiveTabRaw\(id\); \}/.test(dash)
        && /const setActiveView = useCallback\(\(id: string\) => \{ if \(id === activeView \|\| confirmLeaveCommsContent\(\)\) setActiveViewRaw\(id\); \}/.test(dash)
        && !/onSelect=\{setActiveViewRaw\}|onSelectTab=\{setActiveTabRaw\}/.test(dash));
    const lib = strip("components/platform/comms/LibraryView.tsx");
    check("the Library drawer close / row change asks the same guard and reports dirtiness to it", /confirmLeaveCommsContent\(\)/.test(lib) && /onDirty=\{setUnsavedCommsContent\}/.test(lib));
  }

  if (failures > 0) { console.error(`\ncontent-editor.test: ${failures} failure(s).`); process.exit(1); }
  console.log("\ncontent-editor.test: all passed.");
}

void main();
