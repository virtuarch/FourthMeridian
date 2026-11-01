/**
 * lib/platform/policies/operational-controls.types.ts  (PLATFORM OPS — Operational Controls)
 *
 * The client-safe contract of GET/PATCH /api/platform/platform-ops/operational-controls:
 * the read model the Policies → "Operational Controls" panel renders and the
 * closed mutation body it sends. No server import — the widget reads it.
 *
 * ONE CONTROL TODAY: maintenance mode, the existing `maintenance_mode`
 * PlatformSetting row (lib/platform-settings.ts; judged by the admission
 * policy, lib/platform/admission/policy-core.ts). There is no second source of
 * truth: the read model is that row, resolved by the admission module's own
 * fact reader. The AI kill switch and the ingestion pause are carried READ-ONLY
 * so the panel can say what maintenance is NOT; neither is writable here.
 */

/** The literal the workspace-session hooks need (the static-url contract). */
export const OPERATIONAL_CONTROLS_URL = "/api/platform/platform-ops/operational-controls";

/**
 * The row's state, in the admission module's words:
 *   ON       the row is "true"   — maintenance is ENABLED
 *   OFF      the row is "false"  — maintenance is DISABLED (explicitly)
 *   MISSING  no row              — NOT CONFIGURED (absent ⇒ off, by contract)
 *   INVALID  any other value     — the admission policy DENIES (fail closed)
 */
export type FlagState = "ON" | "OFF" | "MISSING" | "INVALID";

/** Where this server runs — so the operator can never mistake Preview for Production. */
export type DeploymentEnvironmentName = "production" | "preview" | "development";

export interface FlagView {
  key: string;
  state: FlagState;
  /** The stored text when INVALID (so the operator sees what is there); null otherwise. */
  invalidRaw: string | null;
  /** The row version (`updatedAt`) — the optimistic-concurrency token. Null when there is no row. */
  updatedAt: string | null;
  /** Display NAME of the last writer, never an email. Null for no row / a non-user writer. */
  updatedBy: string | null;
}

export interface OperationalControlsReadModel {
  checkedAt: string;
  environment: DeploymentEnvironmentName;
  maintenance: FlagView & {
    /** The admission work classes maintenance denies — read from the policy, not restated. */
    blocks: readonly string[];
  };
  /**
   * BETA LIFECYCLE L2 — the GLOBAL cost freeze (`platform_cost_frozen`): while
   * ON (or unreadable — INVALID), no operation that can incur a provider charge
   * starts, for any customer or platform-wide. Writable here (PATCH with
   * `control: "COST_FREEZE"`), beside maintenance. This is the PLATFORM flag; a
   * policy group's own freeze is that group's `costFrozen` (Policy Groups).
   */
  costFreeze: FlagView;
  /** Read-only neighbours, so the panel can distinguish them. Not writable through this route. */
  related: {
    aiKillSwitch: Pick<FlagView, "key" | "state">;
    ingestionPaused: Pick<FlagView, "key" | "state">;
  };
}

/** ENABLE ⇒ "true" · DISABLE ⇒ "false" · RESET ⇒ delete the row (back to Not configured). */
export type MaintenanceAction = "ENABLE" | "DISABLE" | "RESET";
export const MAINTENANCE_ACTIONS: readonly MaintenanceAction[] = ["ENABLE", "DISABLE", "RESET"];

/** Which control a PATCH changes. Absent ⇒ MAINTENANCE (the original contract). */
export type OperationalControlName = "MAINTENANCE" | "COST_FREEZE";
export const OPERATIONAL_CONTROL_NAMES: readonly OperationalControlName[] = ["MAINTENANCE", "COST_FREEZE"];

/** The PATCH body. `expectedUpdatedAt` is the version the operator read (null ⇒ "I saw no row"). */
export interface MaintenanceChangeBody {
  /** BETA LIFECYCLE L2 — "COST_FREEZE" targets the global cost freeze; absent ⇒ maintenance. */
  control?: OperationalControlName;
  action: MaintenanceAction;
  expectedUpdatedAt: string | null;
  reason: { code: string; note: string };
}

export type OperationalControlsMutationCode = "VALIDATION" | "CONFLICT" | "NOT_FOUND";

export interface OperationalControlsRefusal {
  error: string;
  code: OperationalControlsMutationCode;
  model: OperationalControlsReadModel;
}
