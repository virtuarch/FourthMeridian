/**
 * components/platform/widgets/maintenance-mode-view.ts  (PLATFORM OPS — Operational Controls: pure view rules)
 *
 * Every word and decision the Maintenance mode panel renders, pure and tested
 * (maintenance-mode.test.ts). The panel (MaintenanceModePanel.tsx) only lays
 * these out. The SERVER is the authority on who may write and on what was
 * persisted; this file decides only what to show.
 */

import type { StatusTone } from "../platform-surface";
import type {
  DeploymentEnvironmentName, FlagState, MaintenanceAction, OperationalControlsReadModel,
} from "@/lib/platform/policies/operational-controls.types";
import { resolveMutationOutcome, type MutationOutcome, type PolicyNotice } from "./policies-view";

export const OPERATIONAL_CONTROLS_TITLE = "Operational Controls";
export const OPERATIONAL_CONTROLS_SUBJECT = "operational controls";
export const MAINTENANCE_LABEL = "Maintenance mode";

/** The three words the owner asked for, plus the fail-closed one. */
export function maintenanceStateWord(state: FlagState): { word: string; tone: StatusTone } {
  switch (state) {
    case "ON":      return { word: "Enabled", tone: "warn" };
    case "OFF":     return { word: "Disabled", tone: "ok" };
    case "MISSING": return { word: "Not configured", tone: "ok" };
    case "INVALID": return { word: "Unreadable — work is denied", tone: "bad" };
  }
}

/** Off by contract when absent; the caption says so, so "Not configured" never reads as "unknown". */
export function maintenanceCaption(state: FlagState): string {
  switch (state) {
    case "ON":      return "The platform is in maintenance. New work below is refused until it is disabled or reset.";
    case "OFF":     return "Explicitly disabled. Work is admitted normally.";
    case "MISSING": return "No setting is stored, which means off. Work is admitted normally.";
    case "INVALID": return "The stored value is not true or false, so the admission policy refuses work (fail closed). Disable or reset it.";
  }
}

const WORK_WORDS: Record<string, string> = {
  PAID_AI_REQUEST: "Paid AI requests are blocked (Conversations, Daily Brief).",
  REFRESH_EXECUTION: "Account refreshes are blocked (bank and wallet, scheduled and manual).",
  CONNECTION_ESTABLISHMENT: "New bank connections are blocked.",
};

/** What maintenance does, from the policy's own work-class list — never restated by hand. */
export function maintenanceConsequences(blocks: readonly string[]): string[] {
  const ordered = ["PAID_AI_REQUEST", "REFRESH_EXECUTION", "CONNECTION_ESTABLISHMENT"].filter((w) => blocks.includes(w));
  const extra = blocks.filter((w) => !ordered.includes(w));
  return [
    ...ordered.map((w) => WORK_WORDS[w]),
    ...extra.map((w) => `${w.replace(/_/g, " ").toLowerCase()} is blocked.`),
    "Work already in flight is not cancelled and may finish.",
    "Sign-in, Platform Ops, this control, audit logging and health checks keep working.",
  ];
}

/** How maintenance differs from its two neighbours. */
export const DISTINCTION_LINES = [
  "Paid AI kill switch (AI Cost Controls): stops paid AI only. Independent of maintenance; either one blocks paid AI.",
  "Ingestion pause: stops account refreshes only. Connections and AI continue.",
  "Global cost freeze: stops every new provider-charging operation, for every customer and platform-wide, until unfrozen. Stored data stays readable.",
] as const;

export function relatedStateWord(state: FlagState, onWord: string): string {
  return state === "ON" ? onWord : state === "INVALID" ? "unreadable (denies)" : "off";
}

export function environmentBadge(env: DeploymentEnvironmentName): { word: string; tone: StatusTone } {
  return env === "production" ? { word: "PRODUCTION", tone: "bad" } : env === "preview" ? { word: "PREVIEW", tone: "info" } : { word: "DEVELOPMENT", tone: "muted" };
}

/** Which actions the current state offers. Reset only when a row exists. */
export function availableActions(state: FlagState): MaintenanceAction[] {
  switch (state) {
    case "ON":      return ["DISABLE", "RESET"];
    case "OFF":     return ["ENABLE", "RESET"];
    case "MISSING": return ["ENABLE"];
    case "INVALID": return ["DISABLE", "RESET"];
  }
}

export const ACTION_LABEL: Record<MaintenanceAction, string> = {
  ENABLE: "Enable maintenance",
  DISABLE: "Disable maintenance",
  RESET: "Reset to not configured",
};

/** The state a successful action must read back as. */
export const EXPECTED_STATE: Record<MaintenanceAction, FlagState> = { ENABLE: "ON", DISABLE: "OFF", RESET: "MISSING" };

/** The sentence the operator confirms — it names the environment and the host, so Preview and Production cannot be confused. */
export function confirmationSentence(action: MaintenanceAction, env: DeploymentEnvironmentName, host: string | null): string {
  const where = `${environmentBadge(env).word}${host ? ` (${host})` : ""}`;
  switch (action) {
    case "ENABLE":  return `You are enabling maintenance on ${where}. Paid AI, account refreshes and new bank connections stop for every customer until it is disabled or reset.`;
    case "DISABLE": return `You are disabling maintenance on ${where}. An explicit "off" is stored; work resumes on the next request.`;
    case "RESET":   return `You are resetting maintenance on ${where} to not configured. The stored row is deleted; absent means off, so work resumes on the next request.`;
  }
}

export function confirmLabel(action: MaintenanceAction, env: DeploymentEnvironmentName): string {
  const where = environmentBadge(env).word.toLowerCase();
  return action === "ENABLE" ? `Confirm: enable on ${where}` : action === "DISABLE" ? `Confirm: disable on ${where}` : `Confirm: reset on ${where}`;
}

export const APPLIED_TEXT: Record<MaintenanceAction, string> = {
  ENABLE: "Saved — maintenance is enabled.",
  DISABLE: "Saved — maintenance is disabled.",
  RESET: "Saved — maintenance is not configured.",
};

/**
 * The shared outcome rule, plus one guard: "applied" only counts as success
 * when the canonical model the server returned READS the state the action
 * promised. Anything else is shown as a mismatch, never as "Saved".
 */
export function resolveMaintenanceOutcome(
  outcome: MutationOutcome<OperationalControlsReadModel>,
  action: MaintenanceAction,
): { model: OperationalControlsReadModel | null; close: boolean; notice: PolicyNotice } {
  if (outcome.kind === "applied") {
    const state = outcome.model?.maintenance?.state;
    if (state !== EXPECTED_STATE[action]) {
      return {
        model: outcome.model?.maintenance ? outcome.model : null,
        close: false,
        notice: { tone: "bad", text: `The server did not confirm the change: maintenance reads "${state ? maintenanceStateWord(state).word : "unknown"}". Reload and check before trying again.` },
      };
    }
  }
  return resolveMutationOutcome(outcome, APPLIED_TEXT[action]);
}

/** The PATCH body — the version the operator read, the action, the reason. */
export function maintenancePatchBody(model: OperationalControlsReadModel, action: MaintenanceAction, reason: { code: string; note?: string }) {
  return { action, expectedUpdatedAt: model.maintenance.updatedAt, reason: { code: reason.code, note: reason.note ?? "" } };
}

export function lastChangedText(model: OperationalControlsReadModel, format: (iso: string) => string): string | null {
  const m = model.maintenance;
  if (!m.updatedAt) return null;
  return `Last changed ${format(m.updatedAt)}${m.updatedBy ? ` by ${m.updatedBy}` : ""}`;
}

// ── BETA LIFECYCLE L2 — the GLOBAL cost freeze (owner ruling 2026-10-31) ──────
// Same contract as maintenance (PATCH with `control: "COST_FREEZE"`): an action,
// the version read, a reason AND a note; "Saved" only when the server's model
// reads the promised state.

export const COST_FREEZE_LABEL = "Global cost freeze";

export function costFreezeStateWord(state: FlagState): { word: string; tone: StatusTone } {
  switch (state) {
    case "ON":      return { word: "Frozen", tone: "bad" };
    case "OFF":     return { word: "Not frozen", tone: "ok" };
    case "MISSING": return { word: "Not configured", tone: "muted" };
    case "INVALID": return { word: "Unreadable — frozen", tone: "bad" };
  }
}

export function costFreezeCaption(state: FlagState): string {
  return state === "ON" || state === "INVALID"
    ? "No new provider-charging work starts — for any customer, or platform-wide (market data, historical prices, FX, crypto price steps). Stored data, exports and existing Briefs stay readable; nothing is disconnected."
    : "Paid work runs normally. Freezing stops every new provider-charging operation until unfrozen; it never disconnects anyone or deletes data.";
}

export const COST_FREEZE_ACTION_LABEL: Record<MaintenanceAction, string> = {
  ENABLE: "Freeze paid work",
  DISABLE: "Unfreeze",
  RESET: "Reset to not configured",
};

export function costFreezeConfirmationSentence(action: MaintenanceAction, env: DeploymentEnvironmentName, host: string | null): string {
  const where = `${environmentBadge(env).word}${host ? ` (${host})` : ""}`;
  switch (action) {
    case "ENABLE":  return `You are freezing all paid work on ${where}. Every new AI, Plaid, crypto-provider and price-vendor operation stops for every customer, and platform price jobs stop, until it is unfrozen. No one is disconnected.`;
    case "DISABLE": return `You are unfreezing paid work on ${where}. An explicit "off" is stored; paid work resumes within about half a minute.`;
    case "RESET":   return `You are resetting the cost freeze on ${where} to not configured. The stored row is deleted; absent means off, so paid work resumes.`;
  }
}

const COST_FREEZE_APPLIED: Record<MaintenanceAction, string> = {
  ENABLE: "Saved — paid work is frozen.",
  DISABLE: "Saved — paid work is not frozen.",
  RESET: "Saved — the cost freeze is not configured.",
};

export function resolveCostFreezeOutcome(
  outcome: MutationOutcome<OperationalControlsReadModel>,
  action: MaintenanceAction,
): { model: OperationalControlsReadModel | null; close: boolean; notice: PolicyNotice } {
  if (outcome.kind === "applied") {
    const state = outcome.model?.costFreeze?.state;
    if (state !== EXPECTED_STATE[action]) {
      return {
        model: outcome.model?.costFreeze ? outcome.model : null,
        close: false,
        notice: { tone: "bad", text: `The server did not confirm the change: the cost freeze reads "${state ? costFreezeStateWord(state).word : "unknown"}". Reload and check before trying again.` },
      };
    }
  }
  return resolveMutationOutcome(outcome, COST_FREEZE_APPLIED[action]);
}

export function costFreezePatchBody(model: OperationalControlsReadModel, action: MaintenanceAction, reason: { code: string; note?: string }) {
  return { control: "COST_FREEZE" as const, action, expectedUpdatedAt: model.costFreeze?.updatedAt ?? null, reason: { code: reason.code, note: reason.note ?? "" } };
}
