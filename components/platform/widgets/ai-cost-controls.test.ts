/**
 * components/platform/widgets/ai-cost-controls.test.ts  (AI COST CONTROLS — Agent B)
 *
 * THE "AI COST CONTROLS" GROUP, RENDERED — every state provable by handing the
 * prop-driven panel and editor fake props: the three origins, enabled /
 * disabled, editable vs not (no affordance without it), validation before
 * submission, the confirmation gates (disabling enforcement; pausing AND
 * resuming), the PATCH body the pure helper builds for a changed card and for
 * Restore defaults, the 409 handling rule, and the Customer Success override
 * editor's helpers and source pins. No DB, no network.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/ai-cost-controls.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import {
  AI_COST_CONTROLS_URL, AI_COST_CONTROL_CONFIRMATION, AI_COST_CONTROL_SETTING_KEYS,
  type AiCostControlKey, type AiCostControlsReadModel, type ControlValueView,
} from "@/lib/platform/ai/cost-controls.types";
import { AiCostControlsPanel, CardEditor, ControlFacts } from "./AiCostControlsPanel";
import { resolveMutationOutcome, formatUtc } from "./policies-view";
import {
  RESTORE_TEXT, allowanceEffectiveText, allowanceOverrideBody, cardConsequences, confirmLabel, confirmationSentences, configuredText, controlLegend,
  controlProvenance, draftFromModel, effectiveDefaultText, enforcedWord, firingText, hasStoredRow, originChip, overridesSentence, patchBody, pausedWord,
  resolveDraft, restoreDefaultsChanges, stateWord, validateAllowanceOverrideInput, validateThresholdInput, valueText,
} from "./ai-cost-controls-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const NOW = "2026-10-15T12:00:00.000Z";
const SET_AT = "2026-10-14T09:00:00.000Z";

function cv<V extends boolean | number>(control: AiCostControlKey, label: string, value: V, defaultValue: V, over: Partial<ControlValueView<V>> = {}): ControlValueView<V> {
  return {
    control, settingKey: AI_COST_CONTROL_SETTING_KEYS[control], label, description: `${label} — description`, value, defaultValue,
    origin: "DEFAULT", updatedAt: null, updatedByName: null, bounds: typeof value === "number" ? { min: 1, max: control === "allowance.usd" ? 20 : control === "userAlert.thresholdUsd" ? 10_000 : 100_000 } : null,
    ...over,
  };
}

/** The default picture: every control at its code-owned default, no rows, no overrides, nothing firing. */
function model(mutate: (m: AiCostControlsReadModel) => void = () => {}): AiCostControlsReadModel {
  const m: AiCostControlsReadModel = {
    checkedAt: NOW,
    allowance: {
      enforced: cv("allowance.enforced", "Allowance enforced", true, true),
      usd: cv("allowance.usd", "Daily allowance (USD)", 5, 5),
      ceilingUsd: 20, effectiveDefaultUsd: 5, effectiveDefaultSource: "POLICY",
      overrides: { count: 0, customers: [] },
      enforcementNote: "Judged at the Conversations and Daily Brief routes before the model is called, against the customer's estimated spend since midnight UTC.",
    },
    userAlert: {
      ruleId: "ai-spend-user-high",
      enabled: cv("userAlert.enabled", "Per-user alert enabled", true, true),
      thresholdUsd: cv("userAlert.thresholdUsd", "Per-user threshold (USD / 24 h)", 3, 3),
      status: { live: true, firingNow: false, lastFiredAt: null, recent: [] },
    },
    fleetAlert: {
      ruleId: "ai-spend-fleet-high",
      enabled: cv("fleetAlert.enabled", "Fleet alert enabled", true, true),
      thresholdUsd: cv("fleetAlert.thresholdUsd", "Fleet threshold (USD / 24 h)", 10, 10),
      status: { live: true, firingNow: false, lastFiredAt: null, recent: [] },
    },
    killSwitch: {
      paused: cv("killSwitch.paused", "Paid AI requests paused", false, false),
      customerMessage: "AI features are paused for maintenance. Your data is safe; please try again later.",
    },
    propagation: { cached: false, note: "No decision reads a cached copy; a change is visible to the very next admission, evaluation or turn." },
  };
  mutate(m);
  return m;
}

const render = (m: AiCostControlsReadModel | null, editable = false, loading = false, error: string | null = null) =>
  renderToStaticMarkup(createElement(AiCostControlsPanel, { state: { data: m, loading, error }, editable, onModel: () => {} }));
const editor = (card: "allowance" | "userAlert" | "fleetAlert" | "killSwitch", m: AiCostControlsReadModel, draft: Record<string, boolean | string>, armed = false, intent: "edit" | "reset" = "edit") =>
  renderToStaticMarkup(createElement(CardEditor, { card, model: m, draft, armed, intent, busy: false, notice: null, onDraft: () => {}, onSave: () => {}, onReset: () => {}, onCancel: () => {} }));
const noControls = (html: string) => !/<button|<select|<input|<form/.test(html);

console.log("1. the wording helpers: origin chips, provenance, legend, value words");
{
  check("origin chip words", originChip("DEFAULT") === "Default" && originChip("SETTING") === "Setting" && originChip("INVALID_SETTING") === "Default in force — stored value invalid");
  const d = cv("allowance.usd", "x", 5, 5);
  const s = cv("allowance.usd", "x", 7, 5, { origin: "SETTING", updatedAt: SET_AT, updatedByName: "Chris" });
  const bad = cv("allowance.usd", "x", 5, 5, { origin: "INVALID_SETTING", updatedAt: SET_AT, updatedByName: "Chris" });
  check("provenance: Platform default / Set <UTC date> by <name> / Default in force — stored value is invalid",
    controlProvenance(d, formatUtc) === "Platform default" && controlProvenance(s, formatUtc) === "Set 14 Oct 2026, 09:00 UTC by Chris" && controlProvenance(bad, formatUtc) === "Default in force — stored value is invalid");
  check("provenance never invents a name", controlProvenance(cv("allowance.usd", "x", 7, 5, { origin: "SETTING", updatedAt: SET_AT }), formatUtc) === "Set 14 Oct 2026, 09:00 UTC");
  check("legend numeric: Default $5 · Setting $7 · Max $20; default row reads Setting —; invalid row reads Setting invalid",
    controlLegend(s).map((i) => `${i.label} ${i.value}`).join(" · ") === "Default $5 · Setting $7 · Max $20"
      && controlLegend(d).map((i) => i.value).join() === "$5,—,$20" && controlLegend(bad).map((i) => i.value).join() === "$5,invalid,$20");
  const b = cv("allowance.enforced", "x", false, true, { origin: "SETTING", updatedAt: SET_AT });
  check("legend boolean: Default Enforced · Setting Not enforced, no Max", controlLegend(b).map((i) => `${i.label} ${i.value}`).join(" · ") === "Default Enforced · Setting Not enforced");
  check("value words per control", valueText(b) === "Not enforced" && valueText(cv("killSwitch.paused", "x", true, false)) === "Paused" && valueText(cv("userAlert.enabled", "x", true, true)) === "Enabled" && valueText(d) === "$5");
  check("configured text: stored value / not set / unreadable", configuredText(s) === "$7" && configuredText(d) === "not set" && configuredText(bad) === "unreadable");
  check("hasStoredRow: a version or a non-default origin", !hasStoredRow(d) && hasStoredRow(s) && hasStoredRow(bad) && hasStoredRow(cv("allowance.usd", "x", 5, 5, { updatedAt: SET_AT })));
  check("state words", stateWord(true).word === "Enabled" && stateWord(false).tone === "muted" && enforcedWord(false).word === "Not enforced" && pausedWord(true).word === "Paused" && pausedWord(false).word === "Admitting");
  check("effective default sentence names the source and the ceiling", effectiveDefaultText({ effectiveDefaultUsd: 5, effectiveDefaultSource: "PLATFORM_SETTING", ceilingUsd: 20 }) === "$5 per UTC day for a customer on the default policy with no overlay and no override (platform setting) · ceiling $20");
  check("overrides sentence", overridesSentence(0) === "No per-customer overrides." && overridesSentence(1) === "1 per-customer override in force." && overridesSentence(3) === "3 per-customer overrides in force.");
  const st = (over: Partial<AiCostControlsReadModel["userAlert"]["status"]>) => ({ live: true, firingNow: false, lastFiredAt: null, recent: [], ...over });
  check("firing text: Firing now / Last fired <date> / Never fired / Awaiting authority",
    firingText(st({ firingNow: true }), formatUtc).word === "Firing now" && firingText(st({ lastFiredAt: SET_AT }), formatUtc).word === "Last fired 14 Oct 2026, 09:00 UTC"
      && firingText(st({}), formatUtc).word === "Never fired" && firingText(st({ live: false }), formatUtc).word === "Awaiting authority");
}

console.log("\n2. validation BEFORE submission: whole dollars within the read model's bounds, never empty");
{
  const v = cv("allowance.usd", "x", 5, 5);
  check("empty ⇒ error", validateThresholdInput("", v).error === "Enter a whole-dollar amount." && validateThresholdInput("   ", v).value === null);
  check("not an integer ⇒ error", /whole number/.test(validateThresholdInput("abc", v).error ?? "") && /whole number/.test(validateThresholdInput("2.5", v).error ?? ""));
  check("out of bounds ⇒ error naming the bounds", validateThresholdInput("0", v).error === "Must be between $1 and $20." && validateThresholdInput("21", v).error === "Must be between $1 and $20." && validateThresholdInput("-3", v).value === null);
  check("in bounds ⇒ the integer", validateThresholdInput("7", v).value === 7 && validateThresholdInput(" 20 ", v).error === null);
}

console.log("\n3. the PATCH body: ONE call, only the controls that changed, each with the version the operator read");
{
  const m = model((x) => { x.allowance.usd = cv("allowance.usd", "Daily allowance (USD)", 7, 5, { origin: "SETTING", updatedAt: SET_AT, updatedByName: "Chris" }); });
  const start = draftFromModel(m, "allowance");
  check("the starting draft mirrors the values in force (numbers as raw strings)", start["allowance.enforced"] === true && start["allowance.usd"] === "7");
  check("an unchanged draft produces no change and no error", resolveDraft(m, "allowance", start).changes.length === 0 && Object.keys(resolveDraft(m, "allowance", start).errors).length === 0);
  const r = resolveDraft(m, "allowance", { ...start, "allowance.usd": "9" });
  check("only the changed control is in changes, with the stored row's version", r.changes.length === 1 && r.changes[0].control === "allowance.usd" && r.changes[0].value === 9 && r.changes[0].expectedUpdatedAt === SET_AT);
  const both = resolveDraft(m, "allowance", { "allowance.enforced": false, "allowance.usd": "9" });
  check("two changed controls ⇒ two changes; the default-origin control carries expectedUpdatedAt null", both.changes.length === 2 && both.changes.find((c) => c.control === "allowance.enforced")?.expectedUpdatedAt === null);
  const body = patchBody(both.changes, { code: "INCIDENT", note: "runaway spend" });
  check("the body shape is { changes[], reason{code,note?} } — the frozen AiCostControlsPatchBody",
    JSON.stringify(body) === JSON.stringify({ changes: [
      { control: "allowance.enforced", value: false, expectedUpdatedAt: null },
      { control: "allowance.usd", value: 9, expectedUpdatedAt: SET_AT },
    ], reason: { code: "INCIDENT", note: "runaway spend" } }), JSON.stringify(body));
  check("a note-less reason is sent without a note key", JSON.stringify(patchBody(r.changes, { code: "TESTING" }).reason) === JSON.stringify({ code: "TESTING" }));
  const invalid = resolveDraft(m, "allowance", { ...start, "allowance.usd": "99" });
  check("an invalid threshold is an error, not a change", invalid.changes.length === 0 && invalid.errors["allowance.usd"] === "Must be between $1 and $20.");
  const unreadable = model((x) => { x.userAlert.thresholdUsd = cv("userAlert.thresholdUsd", "t", 3, 3, { origin: "INVALID_SETTING", updatedAt: SET_AT }); });
  const same = resolveDraft(unreadable, "userAlert", draftFromModel(unreadable, "userAlert"));
  check("an INVALID stored row counts as changed at the same value, so Save replaces it", same.changes.length === 1 && same.changes[0].value === 3 && same.changes[0].expectedUpdatedAt === SET_AT);
}

console.log("\n4. Restore defaults: value null for the card's stored rows only");
{
  check("no stored rows ⇒ nothing to restore", restoreDefaultsChanges(model(), "allowance").length === 0 && restoreDefaultsChanges(model(), "killSwitch").length === 0);
  const pausedRow = model((x) => { x.killSwitch.paused = cv("killSwitch.paused", "p", true, false, { origin: "SETTING", updatedAt: SET_AT }); });
  check("the kill switch NEVER restores, even with a stored row (Pause and Resume are its only actions)", restoreDefaultsChanges(pausedRow, "killSwitch").length === 0);
  const m = model((x) => {
    x.allowance.usd = cv("allowance.usd", "u", 7, 5, { origin: "SETTING", updatedAt: SET_AT });
    x.allowance.enforced = cv("allowance.enforced", "e", true, true, { origin: "INVALID_SETTING", updatedAt: "2026-10-13T00:00:00.000Z" });
    x.fleetAlert.thresholdUsd = cv("fleetAlert.thresholdUsd", "f", 25, 10, { origin: "SETTING", updatedAt: SET_AT });
  });
  const r = restoreDefaultsChanges(m, "allowance");
  check("both allowance rows (one valid, one unreadable) are restored with their versions; the fleet row is not touched",
    JSON.stringify(r) === JSON.stringify([{ control: "allowance.enforced", value: null, expectedUpdatedAt: "2026-10-13T00:00:00.000Z" }, { control: "allowance.usd", value: null, expectedUpdatedAt: SET_AT }]), JSON.stringify(r));
  check("the restore body example", JSON.stringify(patchBody(restoreDefaultsChanges(m, "fleetAlert"), { code: "POLICY_ROLLOUT" })) === JSON.stringify({ changes: [{ control: "fleetAlert.thresholdUsd", value: null, expectedUpdatedAt: SET_AT }], reason: { code: "POLICY_ROLLOUT" } }));
}

console.log("\n5. confirmation gates: disabling enforcement; pausing AND resuming; a restore that lifts a pause");
{
  const enforce = AI_COST_CONTROL_CONFIRMATION["allowance.enforced"]?.sentence ?? "";
  const pause = AI_COST_CONTROL_CONFIRMATION["killSwitch.paused"]?.sentence ?? "";
  check("disabling enforcement needs the sentence; enabling does not", confirmationSentences([{ control: "allowance.enforced", value: false, expectedUpdatedAt: null }]).join() === enforce && confirmationSentences([{ control: "allowance.enforced", value: true, expectedUpdatedAt: null }]).length === 0);
  check("pausing AND resuming both need the sentence", confirmationSentences([{ control: "killSwitch.paused", value: true, expectedUpdatedAt: null }]).join() === pause && confirmationSentences([{ control: "killSwitch.paused", value: false, expectedUpdatedAt: SET_AT }]).join() === pause);
  check("a null kill-switch change (never built by the UI) would still resolve to a resume and confirm", confirmationSentences([{ control: "killSwitch.paused", value: null, expectedUpdatedAt: SET_AT }]).join() === pause);
  check("thresholds never confirm; restoring enforcement (null ⇒ default on) does not confirm", confirmationSentences([{ control: "allowance.usd", value: 9, expectedUpdatedAt: null }, { control: "allowance.enforced", value: null, expectedUpdatedAt: SET_AT }]).length === 0);
  check("confirm labels", confirmLabel([{ control: "killSwitch.paused", value: true, expectedUpdatedAt: null }]) === "Confirm pause" && confirmLabel([{ control: "killSwitch.paused", value: false, expectedUpdatedAt: null }]) === "Confirm resume" && confirmLabel([{ control: "allowance.enforced", value: false, expectedUpdatedAt: null }]) === "Confirm and save");
  const lines = cardConsequences("allowance", model(), [{ control: "allowance.usd", value: 9, expectedUpdatedAt: null }]);
  check("consequences name the new default-policy figure, precedence and the ceiling; never a billing claim", /\$9 per UTC day/.test(lines[0]) && /\$20 ceiling clamps last/.test(lines[0]) && !/bill|invoice/i.test(lines.join(" ")));
  check("fleet consequences carry the fleet-excludes-harness sentence", cardConsequences("fleetAlert", model(), []).some((l) => /Harness and operator traffic is overhead/.test(l)));
}

console.log("\n6. the outcome rule (409 handling and its siblings), purely");
{
  const m = model();
  const applied = resolveMutationOutcome({ kind: "applied", model: m }, "Saved.");
  check("200 ⇒ publish, close, ok notice", applied.model === m && applied.close && applied.notice.tone === "ok" && applied.notice.text === "Saved.");
  const conflict = resolveMutationOutcome({ kind: "conflict", model: m, reason: "moved" }, "Saved.");
  check("409 ⇒ the canonical model replaces the surface, the editor closes, the operator is told", conflict.model === m && conflict.close && conflict.notice.tone === "warn" && /changed since you opened the editor/.test(conflict.notice.text));
  const refused = resolveMutationOutcome({ kind: "refused", reason: "allowance.usd must be between 1 and 20.", model: m }, "Saved.");
  check("400 ⇒ the server's sentence, editor open, model refreshed when it came back", refused.model === m && !refused.close && refused.notice.tone === "bad" && /between 1 and 20/.test(refused.notice.text));
  const refusedNoModel = resolveMutationOutcome({ kind: "refused", reason: "x", model: null }, "Saved.");
  check("a refusal without a model publishes nothing", refusedNoModel.model === null && !refusedNoModel.close);
  const failed = resolveMutationOutcome({ kind: "failed", reason: "Not authorized to change this AI cost control." }, "Saved.");
  check("403 ⇒ Not authorized, nothing published, editor open", failed.model === null && !failed.close && /Not authorized/.test(failed.notice.text));
}

console.log("\n7. the panel for a READ / WRITE operator: every fact, no control");
{
  const html = render(model());
  check("the group is titled AI Cost Controls with the governing sentence (estimate, never a bill)", /AI Cost Controls/.test(html) && /never a bill/.test(html));
  check("all four cards by name", ["Per-user daily AI allowance", "Per-user spending alert", "Fleet-wide spending alert", "Pause paid AI requests"].every((t) => html.includes(t)));
  check("state words as ToneBadges: Enforced · Enabled ×2 · Admitting", /font-medium">Enforced</.test(html) && (html.match(/font-medium">Enabled</g) ?? []).length === 2 && /font-medium">Admitting</.test(html));
  check("every control's value in force carries the Default origin chip", (html.match(/>Default</g) ?? []).length === 7);
  check("the legend per control: Default · Setting — (no row); numeric controls carry Max", (html.match(/Setting —/g) ?? []).length === 7 && /Max \$20/.test(html) && /Max \$10000/.test(html) && /Max \$100000/.test(html));
  check("provenance reads Platform default on every control", (html.match(/Platform default/g) ?? []).length === 7);
  check("allowance: ceiling, effective default with its source, no overrides, the Customer Success doorway sentence, the enforcement note",
    /Ceiling/.test(html) && /\$5 per UTC day for a customer on the default policy[^<]*\(policy group\) · ceiling \$20/.test(html) && /No per-customer overrides\./.test(html) && /changed in Customer Success/.test(html) && /since midnight UTC/.test(html));
  check("alerts: rule ids, Never fired, no recent triggers, the fleet-excludes-harness sentence once", /ai-spend-user-high/.test(html) && /ai-spend-fleet-high/.test(html) && (html.match(/Never fired/g) ?? []).length === 2 && (html.match(/Harness and operator traffic is overhead/g) ?? []).length === 1);
  check("the kill switch is a separate emergency region with the sentence customers read and the no-override note", /aria-label="Emergency control"/.test(html) && /paused for maintenance/.test(html) && /No allowance, overlay or override lifts a pause/.test(html));
  check("the propagation posture and the checked time are stated", /visible to the very next admission/.test(html) && /checked 15 Oct 2026, 12:00 UTC/.test(html));
  check("READ-ONLY: no button, select, input or form; no Edit, Save, Restore, Pause", noControls(html) && !/ Edit<\/button>|Save changes|Restore defaults|Pause paid requests/.test(html));
  check("no email, no secret-shaped text, no raw colour", !/@|token|secret/i.test(html) && !/#[0-9a-f]{6}\b/i.test(html));
}

console.log("\n8. the panel with every origin, overrides, firing alerts and a pause");
{
  const m = model((x) => {
    x.allowance.usd = cv("allowance.usd", "Daily allowance (USD)", 7, 5, { origin: "SETTING", updatedAt: SET_AT, updatedByName: "Chris" });
    x.allowance.enforced = cv("allowance.enforced", "Allowance enforced", true, true, { origin: "INVALID_SETTING", updatedAt: SET_AT, updatedByName: "Dana" });
    x.allowance.effectiveDefaultUsd = 7; x.allowance.effectiveDefaultSource = "PLATFORM_SETTING";
    x.allowance.overrides = { count: 2, customers: [{ ref: "user …abc123", usd: 12, updatedAt: SET_AT }, { ref: "user …def456", usd: 20, updatedAt: SET_AT }] };
    x.userAlert.enabled = cv("userAlert.enabled", "Per-user alert enabled", false, true, { origin: "SETTING", updatedAt: SET_AT, updatedByName: "Chris" });
    x.fleetAlert.status = { live: true, firingNow: true, lastFiredAt: NOW, recent: [{ at: NOW, severity: "critical", summary: "Fleet estimated spend $12.40 over 24 h exceeds $10", dedupeKey: "ai-spend-fleet-high:fleet:2026-10-15" }] };
    x.killSwitch.paused = cv("killSwitch.paused", "Paid AI requests paused", true, false, { origin: "SETTING", updatedAt: SET_AT, updatedByName: "Chris" });
  });
  const html = render(m);
  check("a stored threshold: $7 with the Setting chip, legend Setting $7, provenance Set <UTC> by Chris", />\$7</.test(html) && /Setting \$7/.test(html) && /Set 14 Oct 2026, 09:00 UTC by Chris/.test(html));
  check("an unreadable row: the default in force, the chip says so, an alert names when it was last written, never presented as configured",
    /Default in force — stored value invalid/.test(html) && /stored value is unreadable; the default is in force\. Last updated 14 Oct 2026, 09:00 UTC by Dana/.test(html) && /Setting invalid/.test(html));
  check("effective default follows the platform setting", /\$7 per UTC day for a customer on the default policy[^<]*\(platform setting\)/.test(html));
  check("overrides: the count, opaque refs with their USD and date, and the doorway sentence; never an email or a full id", /2 per-customer overrides in force/.test(html) && /user …abc123/.test(html) && /\$12 per UTC day · set 14 Oct 2026/.test(html) && !/@/.test(html) && !/[a-z0-9]{20,}/.test(html.replace(/[a-z]+-[a-z-]+/g, "")));
  check("a disabled rule reads Disabled; a firing rule reads Firing now with its critical delivery", /Disabled/.test(html) && /Firing now/.test(html) && /critical/.test(html) && /exceeds \$10/.test(html) && /delivered 15 Oct 2026, 12:00 UTC/.test(html));
  check("paused: the state word is Paused", />Paused</.test(html));
  check("still no control without editable", noControls(html));
}

console.log("\n9. the affordances, rendered only behind editable (the host forwards canControl under that name)");
{
  const html = render(model(), true);
  check("three Edit buttons and Pause paid requests; no Restore (no stored rows anywhere)", (html.match(/ Edit<\/button>/g) ?? []).length === 3 && /Pause paid requests/.test(html) && !/Restore defaults/.test(html));
  const stored = model((x) => {
    x.allowance.usd = cv("allowance.usd", "u", 7, 5, { origin: "SETTING", updatedAt: SET_AT });
    x.killSwitch.paused = cv("killSwitch.paused", "p", true, false, { origin: "SETTING", updatedAt: SET_AT });
  });
  const html2 = render(stored, true);
  const emergency = (h: string) => h.slice(h.indexOf('aria-label="Emergency control"'));
  check("Restore defaults appears on exactly the cards with a stored row (the allowance); a paused switch offers Resume and NO Restore",
    (html2.match(/Restore defaults/g) ?? []).length === 1 && /Resume paid requests/.test(html2) && !/Pause paid requests/.test(html2) && !/Restore defaults/.test(emergency(html2)));
  check("the unpaused emergency control offers Pause and nothing else: no Restore, no Edit, exactly one button", !/Restore defaults/.test(emergency(html)) && !/ Edit<\/button>/.test(emergency(html)) && (emergency(html).match(/<button/g) ?? []).length === 1);
  check("the paused emergency control offers Resume and nothing else: exactly one button", (emergency(html2).match(/<button/g) ?? []).length === 1 && /Resume paid requests/.test(emergency(html2)));
  check("loading is a status line; failure is an alert naming the subject", /role="status"/.test(render(null, false, true)) && /role="alert"/.test(render(null, false, false, "Request failed (500)")) && /AI cost controls/.test(render(null, false, false, "x")));
}

console.log("\n10. the editor: validation shown before submission, Save gated, reason required, confirmation armed on the second step");
{
  const m = model();
  const ok = editor("allowance", m, { "allowance.enforced": true, "allowance.usd": "9" });
  check("the allowance editor: toggle (Enforced / Not enforced, aria-pressed), a whole-dollar input with min/max, Save changes, Cancel, no Restore (no rows)",
    /aria-pressed="true"[^>]*>Enforced</.test(ok) && /Not enforced/.test(ok) && /min="1" max="20"/.test(ok) && /whole dollars · min \$1 · max \$20/.test(ok) && /Save changes/.test(ok) && /Cancel/.test(ok) && !/Restore defaults/.test(ok));
  check("the reason select is required with no default, plus the optional note", /<select[^>]*required/.test(ok) && /Choose a reason…/.test(ok) && /Note \(optional, no personal data\)/.test(ok));
  check("Save is disabled until a reason is chosen even with a valid change", /<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*>[\s\S]*?Save changes/.test(ok));
  check("consequences name the new default figure and the ceiling", /\$9 per UTC day/.test(ok) && /ceiling clamps last/.test(ok));
  const bad = editor("allowance", m, { "allowance.enforced": true, "allowance.usd": "abc" });
  check("an invalid amount shows its sentence as an alert before any submission", /role="alert"[^>]*>Enter a whole number of dollars/.test(bad) && /aria-invalid="true"/.test(bad));
  const over = editor("allowance", m, { "allowance.enforced": true, "allowance.usd": "21" });
  check("above the ceiling shows the bounds", /Must be between \$1 and \$20\./.test(over));
  const disabling = editor("allowance", m, { "allowance.enforced": false, "allowance.usd": "5" });
  check("disabling enforcement, not yet armed: no confirmation sentence, the button still reads Save changes", !/lets every customer exceed/.test(disabling) && /Save changes/.test(disabling));
  const armed = editor("allowance", m, { "allowance.enforced": false, "allowance.usd": "5" }, true);
  check("armed: the confirmation sentence is an alert and the button reads Confirm and save", /role="alert"[^>]*>Disabling enforcement lets every customer exceed/.test(armed) && /Confirm and save/.test(armed));
  const pause = editor("killSwitch", m, { "killSwitch.paused": true }, true);
  check("pausing (armed at open): Paused pressed, the customer sentence previewed, the pause sentence as an alert, Confirm pause",
    /aria-pressed="true"[^>]*>Paused</.test(pause) && /While paused, customers read/.test(pause) && /role="alert"[^>>]*>Pausing refuses every new paid AI request/.test(pause) && /Confirm pause/.test(pause));
  const pausedModel = model((x) => { x.killSwitch.paused = cv("killSwitch.paused", "p", true, false, { origin: "SETTING", updatedAt: SET_AT }); });
  const resume = editor("killSwitch", pausedModel, { "killSwitch.paused": false }, true);
  check("resuming confirms too: the same sentence, Confirm resume, and NO Restore defaults even though a row exists", /Pausing refuses every new paid AI request/.test(resume) && /Confirm resume/.test(resume) && !/Restore defaults/.test(resume));
  const unarmedResume = editor("killSwitch", pausedModel, { "killSwitch.paused": false }, false);
  check("unarmed resume reads Resume paid requests", /Resume paid requests/.test(unarmedResume) && !/Confirm resume/.test(unarmedResume));
  const reset = editor("allowance", model((x) => { x.allowance.usd = cv("allowance.usd", "u", 7, 5, { origin: "SETTING", updatedAt: SET_AT }); }), {}, false, "reset");
  check("restore intent: the restore sentence, Confirm restore, no value control, reason still required, no Save", new RegExp(RESTORE_TEXT.slice(0, 40)).test(reset) && /Confirm restore/.test(reset) && !/<input type="number"/.test(reset) && /Choose a reason…/.test(reset) && !/Save changes/.test(reset));
  const alert = editor("fleetAlert", m, { "fleetAlert.enabled": true, "fleetAlert.thresholdUsd": "25" });
  check("the fleet editor: Enabled / Disabled toggle, threshold within $1–$100000, the trailing-24 h consequence and the fleet scope sentence", /Enabled/.test(alert) && /max \$100000/.test(alert) && /trailing 24 hours at the next evaluation/.test(alert) && /Harness and operator traffic is overhead/.test(alert));
  const facts = renderToStaticMarkup(createElement(ControlFacts, { view: cv("userAlert.thresholdUsd", "Per-user threshold", 3, 3) }));
  check("ControlFacts alone: label, $3, Default chip, legend, provenance", /Per-user threshold/.test(facts) && />\$3</.test(facts) && />Default</.test(facts) && /aria-label="Control bounds"/.test(facts) && /Platform default/.test(facts));
}

console.log("\n11. Customer Success — the allowance override helpers");
{
  check("integer ≥ 1 is the client gate; the ceiling is the server's", validateAllowanceOverrideInput("7").value === 7 && validateAllowanceOverrideInput("").error === "Enter a whole-dollar amount." && /whole number/.test(validateAllowanceOverrideInput("2.5").error ?? "") && validateAllowanceOverrideInput("0").error === "Must be at least $1." && validateAllowanceOverrideInput("999").value === 999);
  check("effective text: absent field is an honest sentence, never $0", allowanceEffectiveText(undefined) === "Effective allowance not reported by this build.");
  check("effective text with and without an override", allowanceEffectiveText({ usd: 20, source: "OVERLAY", override: null }) === "$20 per UTC day (overlay) · no override · estimated" && allowanceEffectiveText({ usd: 7, source: "USER_OVERRIDE", override: 7 }) === "$7 per UTC day (customer override) · override $7 · estimated");
  check("the body carries only the override and the reason", JSON.stringify(allowanceOverrideBody(7, { code: "SUPPORT_REQUEST" })) === JSON.stringify({ aiDailyUsdAllowanceOverride: 7, reason: { code: "SUPPORT_REQUEST" } }) && allowanceOverrideBody(null, { code: "OTHER" }).aiDailyUsdAllowanceOverride === null);
}

console.log("\n12. source: the panel's writes, the host's forwarding, the Customer Success wiring, the capability ratchet");
{
  const strip = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  const panel = strip("components/platform/widgets/AiCostControlsPanel.tsx");
  check("the panel PATCHes the one url from the types file and never DELETEs or POSTs", (panel.match(/mutate<AiCostControlsReadModel>\(AI_COST_CONTROLS_URL, "PATCH"/g) ?? []).length === 2 && !/"DELETE"|"POST"/.test(panel));
  check("the panel builds both bodies with the pure helper", /patchBody\(changes, reason\)/.test(panel) && /restoreDefaultsChanges\(model, card\)/.test(panel));
  check("the panel never names the capability (the ratchet in capability-control.test.ts scans for it) — the host forwards the flag as `editable`",
    !/canControl/.test(panel) && !/\bCONTROL\b/.test(panel) && /editable/.test(panel));
  check("confirmation arms on the first Save and submits on the second", /if \(confirmationSentences\(changes\)\.length > 0 && !armed\) \{ setArmed\(true\); return; \}/.test(panel));
  check("no polling, no router, no raw colour", !/setInterval|useRouter|next\/link/.test(panel) && !/#[0-9a-f]{3,6}\b/i.test(panel));
  const host = strip("components/platform/widgets/OpsPoliciesWidget.tsx");
  check("the Policies host composes the panel beneath the cadence panel, forwarding canControl as editable, and no longer renders Cost safeguards",
    /<AiCostControlsPanel state=\{costControls\} editable=\{canControl\} onModel=\{onCostControlsModel\} \/>/.test(host) && !/CostSafeguardsPanel|ai-spend/.test(host));
  check("the host reads and publishes the cost-controls url through the workspace session", /COST_CONTROLS_URL = "\/api\/platform\/platform-ops\/ai-cost-controls"/.test(host) && /useSharedWidgetFetch<AiCostControlsReadModel>\(COST_CONTROLS_URL\)/.test(host) && /useSharedWidgetPublish<AiCostControlsReadModel>\(COST_CONTROLS_URL\)/.test(host) && AI_COST_CONTROLS_URL === "/api/platform/platform-ops/ai-cost-controls");
  const cs = strip("components/platform/widgets/CsCustomersWidget.tsx");
  check("Customer Success posts ONLY the override and the reason to the policy route, and offers Remove override (null)",
    /allowanceOverrideBody\(allowanceCheck\.value, reason\)/.test(cs) && /allowanceOverrideBody\(null, reason\)/.test(cs) && /Remove override/.test(cs) && /customers\/\$\{detail\.identity\.id\}\/policy/.test(cs));
  check("Customer Success validates client-side before enabling Set override and shows the effective allowance folded from the policy view's aiDailyAllowance + aiDailyUsdAllowanceOverride fields",
    /allowanceCheck\.value === null/.test(cs) && /allowanceEffectiveText\(allowance\)/.test(cs) && /aiDailyAllowance\.usd/.test(cs) && /aiDailyUsdAllowanceOverride \?\? null/.test(cs));
  check("nothing posts while typing: the input only sets state", /onChange=\{\(e\) => setAllowanceInput\(e\.target\.value\)\}/.test(cs) && !/onChange=\{[^}]*run\(/.test(cs));
  const view = strip("components/platform/widgets/ai-cost-controls-view.ts");
  check("the view-model is pure (no React, no clock, no fetch)", !/from "react"|Date\.now\(\)|new Date\(\)|fetch\(/.test(view));
  check("the budget url is not written by anyone in components", !/AI_BUDGET_URL[^;]*"PATCH"/.test(strip("components/platform/widgets/OpsAiBudgetWidget.tsx")));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
