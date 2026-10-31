/**
 * components/platform/widgets/maintenance-mode.test.ts  (PLATFORM OPS — Operational Controls panel)
 *
 * The panel says Enabled / Disabled / Not configured, names the environment,
 * lists what maintenance blocks (from the policy's work classes) and what it
 * is not, offers only the actions the state allows, disables them for a
 * non-editor, and NEVER shows "Saved" unless the server's canonical model
 * reads the promised state. Renders are static (no effects); the outcome rule
 * is pure.
 *
 *   npx tsx --require ./scripts/lib/server-only-preload.cjs components/platform/widgets/maintenance-mode.test.ts
 */

import { costFreezePatchBody, costFreezeConfirmationSentence, resolveCostFreezeOutcome } from "./maintenance-mode-view";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { FlagState, OperationalControlsReadModel } from "@/lib/platform/policies/operational-controls.types";
import { MaintenanceModePanel } from "./MaintenanceModePanel";
import {
  APPLIED_TEXT, availableActions, confirmationSentence, confirmLabel, environmentBadge, maintenanceConsequences,
  maintenancePatchBody, maintenanceStateWord, resolveMaintenanceOutcome,
} from "./maintenance-mode-view";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const BLOCKS = ["REFRESH_EXECUTION", "CONNECTION_ESTABLISHMENT", "PAID_AI_REQUEST"];
function model(state: FlagState, environment: OperationalControlsReadModel["environment"] = "preview"): OperationalControlsReadModel {
  return {
    checkedAt: "2026-10-24T20:00:00.000Z",
    environment,
    maintenance: {
      key: "fact:maintenance", state, invalidRaw: state === "INVALID" ? "yes" : null,
      updatedAt: state === "MISSING" ? null : "2026-10-24T20:00:00.000Z", updatedBy: state === "MISSING" ? null : "Ops Person", blocks: BLOCKS,
    },
    costFreeze: { key: "platform_cost_frozen", state: "MISSING", invalidRaw: null, updatedAt: null, updatedBy: null },
    related: { aiKillSwitch: { key: "fact:kill-switch", state: "OFF" }, ingestionPaused: { key: "fact:ingestion", state: "MISSING" } },
  };
}
const render = (m: OperationalControlsReadModel | null, editable = true, extra: Partial<{ loading: boolean; error: string | null }> = {}) =>
  renderToStaticMarkup(createElement(MaintenanceModePanel, { state: { data: m, loading: extra.loading ?? false, error: extra.error ?? null }, editable }));

console.log("state words");
check("ON ⇒ Enabled", maintenanceStateWord("ON").word === "Enabled");
check("OFF ⇒ Disabled", maintenanceStateWord("OFF").word === "Disabled");
check("MISSING ⇒ Not configured", maintenanceStateWord("MISSING").word === "Not configured");
check("INVALID ⇒ says work is denied", /denied/.test(maintenanceStateWord("INVALID").word));

console.log("consequences + distinctions");
{
  const lines = maintenanceConsequences(BLOCKS).join(" | ");
  check("paid AI, refreshes and new bank connections are named", /Paid AI requests are blocked/.test(lines) && /Account refreshes are blocked/.test(lines) && /New bank connections are blocked/.test(lines));
  check("in-flight work may finish", /in flight is not cancelled and may finish/.test(lines));
  check("sign-in and this control keep working", /Sign-in, Platform Ops, this control/.test(lines));
  const html = render(model("MISSING"));
  check("the panel distinguishes the kill switch and the ingestion pause", /Paid AI kill switch/.test(html) && /Ingestion pause/.test(html) && /Not the same as/.test(html));
}

console.log("environment");
check("production is loud", environmentBadge("production").word === "PRODUCTION" && environmentBadge("production").tone === "bad");
check("preview is labelled", environmentBadge("preview").word === "PREVIEW");
check("the confirmation names environment and host", /PREVIEW \(preview-app\.fourthmeridian\.com\)/.test(confirmationSentence("ENABLE", "preview", "preview-app.fourthmeridian.com")));
check("the confirm button names the environment", confirmLabel("ENABLE", "production") === "Confirm: enable on production");
check("the rendered panel shows the environment badge", /aria-label="Environment: PREVIEW"/.test(render(model("MISSING"))) && /Environment: PRODUCTION/.test(render(model("OFF", "production"))));

console.log("actions follow the state");
check("Not configured ⇒ Enable only (nothing to reset)", availableActions("MISSING").join() === "ENABLE");
check("Enabled ⇒ Disable or Reset", availableActions("ON").join() === "DISABLE,RESET");
check("Disabled ⇒ Enable or Reset", availableActions("OFF").join() === "ENABLE,RESET");
check("Unreadable ⇒ Disable or Reset (never Enable)", availableActions("INVALID").join() === "DISABLE,RESET");
{
  const on = render(model("ON"));
  check("Enabled renders Enabled + Disable + Reset", /Enabled/.test(on) && /Disable maintenance/.test(on) && /Reset to not configured/.test(on) && !/>[^<]*Enable maintenance/.test(on));
  const off = render(model("MISSING"));
  check("Not configured renders Enable and no Reset", /Not configured/.test(off) && /Enable maintenance/.test(off) && !/Reset to not configured/.test(off));
  const ro = render(model("MISSING"), false);
  check("a non-editor sees the state but every action is disabled", /<button[^>]*disabled=""[^>]*>[\s\S]*?Enable maintenance/.test(ro) && /highest Platform Ops grant level/.test(ro));
  check("loading and error states render", /role="status"/.test(render(null, true, { loading: true })) && /role="alert"/.test(render(null, true, { error: "boom" })));
  check("an unreadable row shows its stored value", /Stored value: <code>yes<\/code>/.test(render(model("INVALID"))));
}

console.log("success only after the server confirms");
{
  const ok = resolveMaintenanceOutcome({ kind: "applied", model: model("ON") }, "ENABLE");
  check("applied + model reads ON ⇒ Saved", ok.notice.tone === "ok" && ok.notice.text === APPLIED_TEXT.ENABLE && ok.close);
  const lie = resolveMaintenanceOutcome({ kind: "applied", model: model("MISSING") }, "ENABLE");
  check("applied but model still Not configured ⇒ NOT Saved, form stays open", lie.notice.tone === "bad" && !lie.close && !/Saved/.test(lie.notice.text));
  const empty = resolveMaintenanceOutcome({ kind: "applied", model: null as unknown as OperationalControlsReadModel }, "DISABLE");
  check("applied with no body ⇒ NOT Saved", empty.notice.tone === "bad" && !empty.close);
  const conflict = resolveMaintenanceOutcome({ kind: "conflict", model: model("OFF"), reason: "changed" }, "ENABLE");
  check("409 ⇒ current model replaces the surface, warn, no Saved", conflict.notice.tone === "warn" && conflict.model?.maintenance.state === "OFF");
  const failed = resolveMaintenanceOutcome({ kind: "failed", reason: "Not authorized to change this maintenance setting." }, "ENABLE");
  check("403/network ⇒ error shown, form stays open", failed.notice.tone === "bad" && !failed.close && /Not authorized/.test(failed.notice.text));
  const refused = resolveMaintenanceOutcome({ kind: "refused", reason: "Maintenance changes need a reason note describing why.", model: null }, "ENABLE");
  check("400 ⇒ the server's sentence", refused.notice.tone === "bad" && /reason note/.test(refused.notice.text));
}

console.log("request body");
{
  const b = maintenancePatchBody(model("ON"), "DISABLE", { code: "TESTING", note: "x" });
  check("the PATCH carries the version the operator read, the action and the reason — no setting key",
    b.expectedUpdatedAt === "2026-10-24T20:00:00.000Z" && b.action === "DISABLE" && b.reason.code === "TESTING" && !("key" in b));
  check("Not configured ⇒ expectedUpdatedAt null", maintenancePatchBody(model("MISSING"), "ENABLE", { code: "TESTING", note: "x" }).expectedUpdatedAt === null);
}

console.log("source");
{
  const strip = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const panel = strip("components/platform/widgets/MaintenanceModePanel.tsx");
  const kit = strip("components/platform/widgets/policy-editor-kit.tsx");
  check("the panel writes only through the kit's mutate to the operational-controls url", /mutate<OperationalControlsReadModel>\(OPERATIONAL_CONTROLS_URL, "PATCH"/.test(panel) && !/fetch\(/.test(panel));
  check("the panel requires the note (noteRequired) and adds no input or select of its own", /noteRequired/.test(panel) && !/<input|<select/.test(panel));
  check("the kit's note requirement gates the Confirm button", /hasReason = code !== "" && \(!noteRequired \|\| note\.trim\(\) !== ""\)/.test(kit));
  const widget = strip("components/platform/widgets/OpsPoliciesWidget.tsx");
  check("the host reads the operational-controls url through the workspace session and publishes mutations back",
    /useSharedWidgetFetch<OperationalControlsReadModel>\(OPERATIONAL_URL\)/.test(widget) && /useSharedWidgetPublish<OperationalControlsReadModel>\(OPERATIONAL_URL\)/.test(widget));
  // PLATFORM OPS PHASE 1 UX — re-ruled: the panel now also carries the VIEW's
  // slice flag, which is derived from the variant alone (never from the
  // policies read), so the UI-010 property this pin guards still holds.
  check("the panel renders from its own fetch, not gated on the policies read",
    /\{showEmergency && operational && <MaintenanceModePanel/.test(widget) && /const showEmergency = variant !== "defaults";/.test(widget));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
// ── BETA LIFECYCLE L2 — the global cost freeze toggle (owner ruling 2026-10-31) ──
{
  const frozen = { ...model("OFF"), costFreeze: { key: "platform_cost_frozen", state: "ON" as FlagState, invalidRaw: null, updatedAt: "2026-10-31T09:00:00.000Z", updatedBy: "Ops Person" } };
  const html = render(frozen);
  check("the panel renders a Global cost freeze card with its state (Frozen) and the Unfreeze action",
    /aria-label="Global cost freeze"/.test(html) && html.includes("Frozen") && html.includes("Unfreeze"));
  const off = render(model("OFF"));
  check("…not configured offers Freeze paid work", off.includes("Freeze paid work") && off.includes("Not configured"));
  const ro = render(frozen, false);
  check("…read-only without the highest grant (buttons disabled, the reason shown)", /disabled=""/.test(ro) && ro.includes("Changing the cost freeze needs the highest Platform Ops grant level."));
  check("the PATCH body targets the cost freeze, carrying the version read and the reason",
    JSON.stringify(costFreezePatchBody(frozen, "DISABLE", { code: "SUPPORT_REQUEST", note: "unfreeze" }))
      === JSON.stringify({ control: "COST_FREEZE", action: "DISABLE", expectedUpdatedAt: "2026-10-31T09:00:00.000Z", reason: { code: "SUPPORT_REQUEST", note: "unfreeze" } }));
  check("the confirmation says nobody is disconnected", costFreezeConfirmationSentence("ENABLE", "production", null).includes("No one is disconnected"));
  const applied = resolveCostFreezeOutcome({ kind: "applied", model: { ...frozen, costFreeze: { ...frozen.costFreeze, state: "OFF" } } } as never, "ENABLE");
  check("\"Saved\" only when the server's model reads the promised state", applied.close === false && applied.notice.tone === "bad");
}

process.exit(failures === 0 ? 0 : 1);
