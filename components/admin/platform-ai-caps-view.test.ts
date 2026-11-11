/**
 * components/admin/platform-ai-caps-view.test.ts  (PLATFORM AI CAPS D5 PR5 — the admin caps UI)
 *
 * Pure view-model checks plus source pins and static renders. No DB, no network.
 *
 *   1. refusal code → plain-language message; the lowering warning sentence
 *   2. the three bodies: ONE action each (never a blanket + override mix), the
 *      loaded expectedUpdatedAt passed through, no body without a reason
 *   3. wording: source / value / fits-N / stored / override / You badge
 *   4. POST response → outcome
 *   5. the surface, rendered: labels not ids, You badge, Default, separate blanket forms
 *   6. the page is SYSTEM_ADMIN-only (layout guard + SA-only API) and calls only the caps API
 *   7. the read-only Cost Controls card: no write affordance, no write call, never the operator list
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/admin/platform-ai-caps-view.test.ts
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACTION_FIELDS, loadPlatformAiBlanketCapsSummary } from "@/lib/platform/ai/platform-ai-caps-admin";
import {
  BLANKET_TITLE, CONFLICT_MESSAGE, DEFAULT_WORD, PLATFORM_AI_CAPS_URL, READ_ONLY_EDITED_BY, SELF_EDIT_NOTE, YOU_BADGE,
  appliedText, blanketBody, capValueText, fitsText, hasReason, isSelf, loweringWarningText, newCapLine, overrideBody, overrideText,
  refusalMessage, resetBody, resolveCapsResponse, sourceText, storedText, validateUsdInput,
  type BlanketCapView, type PlatformAiCapsReadModel,
} from "./platform-ai-caps-view";
import { PlatformAiCapsSurface, UsdInput } from "./PlatformAiCapsAdmin";
import { PlatformAiOperatorsCard } from "@/components/platform/widgets/AiCostControlsPanel";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`); }
}

const ROOT = process.cwd();
const strip = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const AT = "2026-11-10T09:00:00.000Z";
const SELF_ID = "usr_self_0000000000000000001";
const OTHER_ID = "usr_other_000000000000000002";

function blanket(key: "per_operator" | "platform", over: Partial<BlanketCapView> = {}): BlanketCapView {
  const ceilingUsd = key === "platform" ? 100 : 20;
  return {
    key, settingKey: key === "platform" ? "platform_ai_daily_usd_platform" : "platform_ai_daily_usd_per_operator", ceilingUsd,
    stored: { state: "SET", usd: key === "platform" ? 10 : 3, updatedAt: AT, updatedBy: "root" },
    effective: { usd: key === "platform" ? 10 : 3, source: "PLATFORM_SETTING", refusal: null },
    fitsTurns: key === "platform" ? 40 : 12,
    ...over,
  } as BlanketCapView;
}

function model(mut: (m: PlatformAiCapsReadModel) => void = () => {}): PlatformAiCapsReadModel {
  const m: PlatformAiCapsReadModel = {
    checkedAt: AT, model: "gpt-test", reserveUsd: 0.25,
    blanket: { perOperator: blanket("per_operator"), platform: blanket("platform") },
    operators: [
      { userId: SELF_ID, ref: "ref_self", label: "root", via: "SYSTEM_ADMIN", override: null, effective: { usd: 3, source: "PLATFORM_SETTING", refusal: null }, fitsTurns: 12 },
      { userId: OTHER_ID, ref: "ref_other", label: "ops-alice", via: "PLATFORM_GRANT", override: { state: "SET", dailyUsd: 7, updatedAt: AT }, effective: { usd: 7, source: "OPERATOR_OVERRIDE", refusal: null }, fitsTurns: 28 },
    ],
    overridesAbovePlatformCap: 0,
    note: "Estimated-dollar caps per UTC day.",
  };
  mut(m);
  return m;
}

const reason = { code: "TESTING" as const };

console.log("1. refusal code → message; the lowering warning");
{
  check("ABOVE_PLATFORM_CAP names the platform cap", refusalMessage("ABOVE_PLATFORM_CAP", "x", 10) === "Higher than the platform cap ($10). Raise the platform cap first.");
  check("PLATFORM_CAP_NOT_SET", refusalMessage("PLATFORM_CAP_NOT_SET", "x", null) === "Set the platform cap first.");
  check("PLATFORM_CAP_INVALID", refusalMessage("PLATFORM_CAP_INVALID", "x", null) === "The platform cap setting is invalid. Fix it first.");
  check("CONFLICT", refusalMessage("CONFLICT", "row moved", 10) === "Someone changed this. Reload and try again." && CONFLICT_MESSAGE === "Someone changed this. Reload and try again.");
  check("VALIDATION falls back to the server's sentence; nothing at all ⇒ a generic sentence",
    refusalMessage("VALIDATION", "A reason is required.", null) === "A reason is required." && refusalMessage(undefined, undefined, null) === "The change was not saved.");
  check("lowering warning: plural, singular, none",
    loweringWarningText({ count: 3 }) === "3 operators have a cap above the new platform cap; the platform cap applies."
      && loweringWarningText({ count: 1 }) === "1 operator has a cap above the new platform cap; the platform cap applies."
      && loweringWarningText({ count: 0 }) === null && loweringWarningText(undefined) === null);
}

console.log("\n2. bodies: one action each, the loaded version, a reason required");
{
  const m = model();
  const bSave = blanketBody(m.blanket.platform, 8, reason)!;
  const bClear = blanketBody(m.blanket.perOperator, null, reason)!;
  const oSet = overrideBody(m.operators[1], 5, reason)!;
  const oSetNew = overrideBody(m.operators[0], 2, reason)!;
  const oReset = resetBody(m.operators[1], reason)!;
  const sameKeys = (o: object, a: keyof typeof ACTION_FIELDS) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...ACTION_FIELDS[a]].sort());
  check("SET_BLANKET carries exactly the server's SET_BLANKET fields (never an override field)", sameKeys(bSave, "SET_BLANKET") && sameKeys(bClear, "SET_BLANKET") && !("targetUserId" in bSave) && !("dailyUsd" in bSave));
  check("SET_OVERRIDE / RESET_OVERRIDE carry exactly their fields (never a blanket field)", sameKeys(oSet, "SET_OVERRIDE") && sameKeys(oReset, "RESET_OVERRIDE") && !("key" in oSet) && !("valueUsd" in oSet) && !("key" in oReset));
  check("one blanket body names ONE key; save and clear are distinct values", bSave.key === "platform" && bSave.valueUsd === 8 && bClear.key === "per_operator" && bClear.valueUsd === null);
  check("expectedUpdatedAt passes through from the loaded state (blanket row, override row)", bSave.expectedUpdatedAt === AT && oSet.expectedUpdatedAt === AT && oReset.expectedUpdatedAt === AT);
  check("no stored row ⇒ expectedUpdatedAt null (blanket absent, override absent)",
    blanketBody(blanket("platform", { stored: { state: "ABSENT", usd: null, updatedAt: null, updatedBy: null } }), 5, reason)!.expectedUpdatedAt === null && oSetNew.expectedUpdatedAt === null);
  check("an INVALID stored row still carries its version (Save replaces it)",
    blanketBody(blanket("platform", { stored: { state: "INVALID", usd: null, updatedAt: AT, updatedBy: null } }), 5, reason)!.expectedUpdatedAt === AT);
  check("the target travels as the id in the body only", oSet.targetUserId === OTHER_ID && oSetNew.targetUserId === SELF_ID);
  check("a reason is required: no reason ⇒ no body, for every action",
    blanketBody(m.blanket.platform, 8, null) === null && overrideBody(m.operators[1], 5, null) === null && resetBody(m.operators[1], null) === null
      && blanketBody(m.blanket.platform, 8, { code: "" as never }) === null && !hasReason(null) && hasReason(reason));
  check("the note is trimmed and dropped when blank", JSON.stringify(blanketBody(m.blanket.platform, 8, { code: "OTHER", note: "  " })!.reason) === JSON.stringify({ code: "OTHER" })
    && blanketBody(m.blanket.platform, 8, { code: "OTHER", note: " lift " })!.reason.note === "lift");
  check("input validation: whole dollars within 0..max", validateUsdInput("0", 20).value === 0 && validateUsdInput("20", 20).value === 20
    && validateUsdInput("21", 20).error === "Must be between $0 and $20." && validateUsdInput("2.5", 20).value === null && validateUsdInput("", 20).value === null && validateUsdInput("-1", 20).value === null);
}

console.log("\n3. wording");
{
  check("sources", sourceText({ source: "PLATFORM_SETTING", refusal: null }) === "Platform setting" && sourceText({ source: "ENV", refusal: null }) === "Deployment setting"
    && sourceText({ source: "CEILING", refusal: null }) === "Fixed ceiling" && sourceText({ source: null, refusal: "CAP_MISSING" }) === "Not set" && sourceText({ source: null, refusal: "CAP_INVALID" }) === "Invalid setting");
  check("values", capValueText({ usd: 3, refusal: null }) === "$3" && capValueText({ usd: null, refusal: "CAP_MISSING" }) === "Not set" && capValueText({ usd: null, refusal: "CAP_INVALID" }) === "Invalid");
  check("fits about N questions at worst case", fitsText(12, { usd: 3, refusal: null }) === "Fits about 12 questions at worst case." && fitsText(1, { usd: 1, refusal: null }) === "Fits about 1 question at worst case."
    && /refused/.test(fitsText(null, { usd: null, refusal: "CAP_MISSING" })) && /not priced/.test(fitsText(null, { usd: 3, refusal: null })));
  check("new-cap line is estimated", newCapLine(5, 0.25) === "New cap $5 per UTC day (estimated) · fits about 20 questions at worst case." && newCapLine(5, null) === "New cap $5 per UTC day (estimated).");
  check("stored / override words", storedText(blanket("platform")) === "$10" && storedText(blanket("platform", { stored: { state: "ABSENT", usd: null, updatedAt: null, updatedBy: null } })) === "not set"
    && overrideText(model().operators[0]) === DEFAULT_WORD && overrideText(model().operators[1]) === "$7");
  check("You badge: only the signed-in admin's row", isSelf(model().operators[0], SELF_ID) && !isSelf(model().operators[1], SELF_ID) && !isSelf(model().operators[0], null));
  check("applied sentences", appliedText(blanketBody(blanket("platform"), null, reason)!, { changed: true }) === "Cleared. The fallback applies."
    && appliedText(resetBody(model().operators[1], reason)!, { changed: true }) === "Reset. The per-operator default applies."
    && appliedText(overrideBody(model().operators[1], 7, reason)!, { changed: false }) === "No change: that is already the value.");
}

console.log("\n4. POST response → outcome");
{
  const m = model();
  const ok = resolveCapsResponse(200, { result: { ok: true, action: "SET_BLANKET", changed: true, warning: { code: "OVERRIDES_ABOVE_PLATFORM_CAP", count: 2, platformCapUsd: 5 } }, model: m }, m);
  check("200 ⇒ applied with the canonical model and the warning", ok.kind === "applied" && ok.model === m && loweringWarningText(ok.result.warning) === "2 operators have a cap above the new platform cap; the platform cap applies.");
  const above = resolveCapsResponse(400, { error: "An override may not exceed the platform cap ($10).", code: "ABOVE_PLATFORM_CAP" }, m);
  check("400 ABOVE_PLATFORM_CAP ⇒ refused, plain sentence with the loaded platform cap", above.kind === "refused" && above.message === "Higher than the platform cap ($10). Raise the platform cap first." && !above.conflict);
  const conflict = resolveCapsResponse(409, { error: "x", code: "CONFLICT" }, m);
  check("409 ⇒ refused CONFLICT, asks for a reload", conflict.kind === "refused" && conflict.conflict && conflict.message === CONFLICT_MESSAGE);
  const notSet = resolveCapsResponse(400, { error: "x", code: "PLATFORM_CAP_NOT_SET" }, m);
  check("400 PLATFORM_CAP_NOT_SET", notSet.kind === "refused" && notSet.message === "Set the platform cap first.");
  const boom = resolveCapsResponse(500, null, m);
  check("500 with no body ⇒ failed, nothing claimed", boom.kind === "failed" && /Nothing was changed/.test(boom.message));
}

console.log("\n5. the surface, rendered");
{
  const noop = async () => ({ kind: "failed" as const, message: "x" });
  const html = renderToStaticMarkup(createElement(PlatformAiCapsSurface, { model: model(), selfUserId: SELF_ID, submit: noop, onReload: () => {} }));
  check("both blanket cards by name, with value, source and fits-N", html.includes(BLANKET_TITLE.per_operator) && html.includes(BLANKET_TITLE.platform)
    && html.includes("Platform setting") && html.includes("Fits about 12 questions at worst case.") && html.includes("Fits about 40 questions at worst case."));
  check("each blanket cap has its OWN Edit and Clear (two separate forms, never one combined save)",
    html.includes(`aria-label="Edit ${BLANKET_TITLE.per_operator}"`) && html.includes(`aria-label="Edit ${BLANKET_TITLE.platform}"`)
      && html.includes(`aria-label="Clear ${BLANKET_TITLE.per_operator}"`) && html.includes(`aria-label="Clear ${BLANKET_TITLE.platform}"`));
  check("operators by the server's label; You badge on self only; Default for no override", html.includes("root") && html.includes("ops-alice")
    && (html.match(new RegExp(`>${YOU_BADGE}<`, "g")) ?? []).length === 1 && html.includes(`>${DEFAULT_WORD}<`) && html.includes(">$7<"));
  check("no raw user id anywhere in the markup", !html.includes(SELF_ID) && !html.includes(OTHER_ID));
  check("the self-edit note is shown when the admin is an operator", html.includes(SELF_EDIT_NOTE));
  check("row actions: Set override, Reset to default (disabled without an override)", html.includes('aria-label="Set override for root"')
    && /<button[^>]*disabled=""[^>]*aria-label="Reset root to default"/.test(html) && /<button(?![^>]*disabled="")[^>]*aria-label="Reset ops-alice to default"/.test(html));
  check("estimated wording", html.includes("Estimated daily spend cap"));
  const noSelf = renderToStaticMarkup(createElement(PlatformAiCapsSurface, { model: model(), selfUserId: null, submit: noop, onReload: () => {} }));
  check("no self ⇒ no You badge, no self note", !noSelf.includes(`>${YOU_BADGE}<`) && !noSelf.includes(SELF_EDIT_NOTE));
  const warn = renderToStaticMarkup(createElement(PlatformAiCapsSurface, { model: model((m) => { m.overridesAbovePlatformCap = 2; }), selfUserId: null, submit: noop, onReload: () => {} }));
  check("overrides above the platform cap ⇒ the count warning", warn.includes("2 operators have a cap above the new platform cap; the platform cap applies."));
  const input = renderToStaticMarkup(createElement(UsdInput, { label: "Platform per day (estimated, whole dollars)", raw: "5", max: 100, busy: false, onChange: () => {}, hint: "$0 to $100" }));
  const id = /<input id="([^"]+)"/.exec(input)?.[1];
  check("inputs are labelled (label for = input id) and bounded", !!id && input.includes(`<label for="${id}"`) && /max="100"/.test(input) && /min="0"/.test(input));
}

console.log("\n6. SA-only page, calls only the caps API");
{
  const layout = strip("app/admin/layout.tsx");
  check("the /admin layout redirects every non-SYSTEM_ADMIN (the page's guard)", layout.includes('if (session.user.role !== "SYSTEM_ADMIN") redirect("/dashboard");'));
  const page = strip("app/admin/platform-ai-caps/page.tsx");
  check("the page lives under app/admin and renders the caps admin with the signed-in id only", page.includes("<PlatformAiCapsAdmin selfUserId={session?.user?.id ?? null} />") && !/fetch\(|db\./.test(page));
  const api = strip("app/api/admin/platform-ai-caps/route.ts");
  check("the API it calls is SYSTEM_ADMIN on GET and fresh SYSTEM_ADMIN on POST", /requireSystemAdmin\(\)/.test(api) && /requireFreshSystemAdmin\(\)/.test(api) && !/requirePlatformAccess/.test(api));
  const ui = strip("components/admin/PlatformAiCapsAdmin.tsx");
  const fetches = ui.match(/fetch\(([^,)]+)/g) ?? [];
  check("the client fetches only PLATFORM_AI_CAPS_URL", fetches.length === 2 && fetches.every((f) => f === "fetch(PLATFORM_AI_CAPS_URL") && PLATFORM_AI_CAPS_URL === "/api/admin/platform-ai-caps", fetches);
  check("every write body comes from the pure builders (never hand-built, never mixed)", !/action:\s*"SET_|expectedUpdatedAt:/.test(ui) && /blanketBody\(view, parsed\.value, reason\)/.test(ui) && /blanketBody\(view, null, reason\)/.test(ui)
    && /overrideBody\(op, parsed\.value, reason\)/.test(ui) && /resetBody\(op, reason\)/.test(ui));
  check("no raw id is rendered: userId is never a JSX child", !/[^=]\{(op\.userId|selfUserId)\}/.test(ui));
  const nav = strip("components/admin/AdminNav.tsx");
  check("the admin nav links the page", nav.includes('href: "/admin/platform-ai-caps"') && nav.includes('"Platform AI caps"'));
}

console.log("\n7. the read-only Cost Controls card");
{
  const caps = { perOperator: { usd: 3, source: "PLATFORM_SETTING" as const, refusal: null, ceilingUsd: 20, fitsTurns: 12 }, platform: { usd: null, source: null, refusal: "CAP_MISSING" as const, ceilingUsd: 100, fitsTurns: null } };
  const html = renderToStaticMarkup(createElement(PlatformAiOperatorsCard, { caps }));
  check("titled Platform AI (operators); both blanket values and their sources", html.includes("Platform AI (operators)") && html.includes(BLANKET_TITLE.per_operator) && html.includes("$3 · Platform setting") && html.includes(">Not set<"));
  check("says where the caps are edited", html.includes(READ_ONLY_EDITED_BY));
  check("no edit affordance: no button, input, select or form", !/<button|<input|<select|<form/.test(html));
  const missing = renderToStaticMarkup(createElement(PlatformAiOperatorsCard, { caps: undefined }));
  check("absent values ⇒ an honest line, still no affordance", /not available/.test(missing) && !/<button|<input/.test(missing));
  const panel = strip("components/platform/widgets/AiCostControlsPanel.tsx");
  const card = panel.slice(panel.indexOf("export function PlatformAiOperatorsCard"), panel.indexOf("export function AiCostControlsPanel"));
  check("the card makes no write call and holds no handler", card.length > 0 && !/fetch\(|mutate\(|onClick|onChange|PLATFORM_AI_CAPS_URL/.test(card));
  check("the panel renders the card from its own read model", /<PlatformAiOperatorsCard caps=\{data\.platformAiCaps\} \/>/.test(panel));
  const route = strip("app/api/platform/platform-ops/ai-cost-controls/route.ts");
  check("the cost-controls route appends the READ-ONLY blanket summary (never the operator list, never a caps write)",
    /loadPlatformAiBlanketCapsSummary\(/.test(route) && !/applyPlatformAiCapsAction|loadPlatformAiCapsReadModel|operators/.test(route));
  check("GET stays PLATFORM_OPS READ", /export async function GET\(\) \{\s*const \[, err\] = await requirePlatformAccess\("PLATFORM_OPS", "READ"\);/.test(route));
  const svc = strip("lib/platform/ai/platform-ai-caps-admin.ts");
  const summary = svc.slice(svc.indexOf("export async function loadPlatformAiBlanketCapsSummary"), svc.indexOf("export interface CapsAdminActor"));
  check("the summary reads settings only: no operator list, no user read, no writer label", summary.length > 0 && !/loadOperators|user\.findMany|platformAiOperatorCap|updatedBy|refOf/.test(summary));
}

async function summaryChecks() {
  console.log("\n8. the blanket summary, resolved like the reservation");
  const PROD = { operatorRaw: undefined, platformRaw: undefined, vercelEnv: "production" };
  const fake = (rows: Array<{ key: string; value: string }>) => ({
    platformSetting: { findMany: async () => rows.map((r) => ({ ...r, updatedAt: new Date(AT), updatedById: null })) },
  }) as never;
  const set = await loadPlatformAiBlanketCapsSummary("gpt-4o-mini", {
    client: fake([{ key: "platform_ai_daily_usd_per_operator", value: "3" }, { key: "platform_ai_daily_usd_platform", value: "10" }]), capInputs: PROD, now: new Date(AT),
  });
  check("settings ⇒ $3 / $10 from PLATFORM_SETTING with ceilings", set.perOperator.usd === 3 && set.perOperator.source === "PLATFORM_SETTING" && set.platform.usd === 10 && set.platform.ceilingUsd === 100 && set.perOperator.ceilingUsd === 20, set);
  check("only the two blanket caps; no operator, override or id field", JSON.stringify(Object.keys(set).sort()) === JSON.stringify(["perOperator", "platform"]) && !/"(userId|ref|operators|updatedBy|override)"/.test(JSON.stringify(set)));
  const none = await loadPlatformAiBlanketCapsSummary("gpt-4o-mini", { client: fake([]), capInputs: PROD, now: new Date(AT) });
  check("nothing set in Production ⇒ CAP_MISSING, no fits figure", none.platform.usd === null && none.platform.refusal === "CAP_MISSING" && none.platform.fitsTurns === null, none);
}

summaryChecks().then(() => {
  if (failures > 0) { console.error(`\nplatform-ai-caps-view: ${failures} check(s) failed.`); process.exit(1); }
  console.log("\nplatform-ai-caps-view: all checks passed.");
}).catch((e) => { console.error(e); process.exit(1); });

