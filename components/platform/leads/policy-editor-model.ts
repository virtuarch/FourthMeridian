/**
 * components/platform/leads/policy-editor-model.ts  (POLICY EDITOR — pure view-model)
 *
 * Words, figures and validation behind the visual policy-group editor
 * (PolicyGroupEditor.tsx). No React, no fetch, no clock. The rules are the
 * server's own pure modules — validation (lib/entitlements/policy-groups.ts),
 * the effective preview and the cost exposure (lib/entitlements/
 * policy-group-preview.ts, i.e. THE resolver and THE allowance precedence) —
 * so what the editor shows is what the server will accept and enforce. The
 * server re-validates everything; this only keeps the operator from guessing.
 */

import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import type { PolicyGroupDetailResponse } from "@/lib/platform/policies/policy-group-detail";
import {
  ENTITLEMENT_CATEGORIES, FOUNDER_INTERNAL_V1, type EntitlementCategory, type EntitlementDimensionKey, type EntitlementValues,
} from "@/lib/entitlements/catalogue";
import {
  FLOOR_MAX_MINUTES, diffEntitlementValues, validateEntitlementValues, validateGroupDescription, validateGroupLabel, validateNewGroupKey,
} from "@/lib/entitlements/policy-groups";
import { estimateAllowanceCeiling, previewEffective } from "@/lib/entitlements/policy-group-preview";
import { PLAIN_LABEL, cellModel } from "./policies-model";
import type { StatusTone } from "../platform-surface";

type Dimension = PolicyGroupsResponse["dimensions"][number];
type Value = boolean | number;

const n = (v: number) => v.toLocaleString("en-US");
const money = (v: number) => `$${n(v)}`;

// ── Modes & draft ─────────────────────────────────────────────────────────────

export type EditorMode =
  | { kind: "edit"; key: string }
  | { kind: "new" }
  | { kind: "clone"; from: string }
  | { kind: "restore"; key: string; toVersion: number };

export interface EditorDraft {
  key: string;
  label: string;
  description: string;
  values: Record<string, Value>;
}

/** The sections, in the editor's order, with the dimensions each holds (from the read route's metadata). */
export const EDITOR_CATEGORY_ORDER: readonly EntitlementCategory[] = ["ai", "connections", "refresh", "exports", "insights"];

export interface EditorSection { id: EntitlementCategory; label: string; dimensions: Dimension[] }

export function editorSections(dimensions: readonly Dimension[]): EditorSection[] {
  return EDITOR_CATEGORY_ORDER.map((id) => ({
    id, label: ENTITLEMENT_CATEGORIES[id], dimensions: dimensions.filter((d) => d.category === id),
  })).filter((s) => s.dimensions.length > 0);
}

/** The floor presets a slider steps through (minutes), clipped to [ceiling, 7 days]. */
export const FLOOR_PRESETS: readonly number[] = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, FLOOR_MAX_MINUTES];

export function floorPresets(ceiling: number): number[] {
  const list = FLOOR_PRESETS.filter((m) => m >= ceiling && m <= FLOOR_MAX_MINUTES);
  return list[0] === ceiling ? list : [ceiling, ...list];
}

/** The preset index nearest a floor value (for the slider position). */
export function nearestPresetIndex(presets: readonly number[], value: number): number {
  let best = 0;
  for (let i = 0; i < presets.length; i++) if (Math.abs(presets[i] - value) < Math.abs(presets[best] - value)) best = i;
  return best;
}

/** One editable row: the control's bounds and the words beside it. */
export type RowModel =
  | { kind: "toggle"; key: string; label: string; on: boolean; allowed: boolean; text: string }
  | { kind: "count"; key: string; label: string; value: number; min: number; max: number; pct: number; text: string; ceilingText: string; money: boolean }
  | { kind: "floor"; key: string; label: string; value: number; min: number; max: number; presets: number[]; pct: number; text: string; ceilingText: string };

export function rowModel(d: Dimension, v: Value | undefined): RowModel {
  const label = PLAIN_LABEL[d.key] ?? d.label;
  if (d.kind === "boolean") return { kind: "toggle", key: d.key, label, on: Boolean(v), allowed: Boolean(d.ceiling), text: v ? "On" : "Off" };
  const value = Number(v ?? 0);
  const ceiling = Number(d.ceiling);
  const cell = cellModel(d, value);
  const pct = cell.kind === "meter" ? cell.pct : 0;
  const text = cell.kind === "missing" ? "—" : cell.text;
  const ceilingText = cell.kind === "meter" ? cell.ceilingText : "";
  if (d.kind === "minutes-floor") {
    return { kind: "floor", key: d.key, label, value, min: ceiling, max: FLOOR_MAX_MINUTES, presets: floorPresets(ceiling), pct, text, ceilingText };
  }
  return { kind: "count", key: d.key, label, value, min: 0, max: ceiling, pct, text, ceilingText, money: d.key === "aiDailyUsdAllowance" };
}

/** Clamp a typed number into the row's bounds (the server refuses out-of-range; the control never sends one). */
export function clampInput(row: Extract<RowModel, { kind: "count" | "floor" }>, raw: number): number {
  if (!Number.isFinite(raw)) return row.value;
  return Math.min(row.max, Math.max(row.min, Math.round(raw)));
}

/** A stepper move: counts by 1; floors to the previous / next preset. */
export function step(row: Extract<RowModel, { kind: "count" | "floor" }>, dir: -1 | 1): number {
  if (row.kind === "count") return clampInput(row, row.value + dir);
  const i = nearestPresetIndex(row.presets, row.value);
  const exact = row.presets[i] === row.value;
  const next = dir > 0 ? (exact || row.presets[i] < row.value ? i + 1 : i) : (exact || row.presets[i] > row.value ? i - 1 : i);
  return row.presets[Math.max(0, Math.min(row.presets.length - 1, next))];
}

// ── Validation (the server's rules) ───────────────────────────────────────────

export function draftErrors(draft: EditorDraft, mode: EditorMode): string[] {
  const errors: string[] = [];
  if (mode.kind === "new" || mode.kind === "clone") {
    const k = validateNewGroupKey(draft.key);
    if (!k.ok) errors.push(k.error);
  }
  const l = validateGroupLabel(draft.label);
  if (!l.ok) errors.push(l.error);
  const de = validateGroupDescription(draft.description);
  if (!de.ok) errors.push(de.error);
  const v = validateEntitlementValues(draft.values);
  if (!v.ok) errors.push(...v.errors);
  return errors;
}

/** "Beta Plus" → "BETA_PLUS" (a suggestion the operator may edit; the server validates). */
export function suggestKey(label: string): string {
  const k = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return /^[A-Z]/.test(k) ? k : k ? `G_${k}`.slice(0, 48) : "";
}

// ── Effective preview ─────────────────────────────────────────────────────────

export interface PreviewCell { text: string; changedByCeiling: boolean; founderText: string | null }

/** Per dimension: the effective value (and with Founder, when the group has Founder assignees). */
export function effectivePreview(dimensions: readonly Dimension[], values: Record<string, Value>, showFounder: boolean): Record<string, PreviewCell> | null {
  const v = validateEntitlementValues(values);
  if (!v.ok) return null;
  const plain = previewEffective(v.values, null);
  const founder = showFounder ? previewEffective(v.values, FOUNDER_INTERNAL_V1.key) : null;
  const out: Record<string, PreviewCell> = {};
  for (const d of dimensions) {
    const k = d.key as EntitlementDimensionKey;
    out[k] = {
      text: valueText(d, plain[k].value),
      changedByCeiling: plain[k].clamped,
      founderText: founder ? valueText(d, founder[k].value) : null,
    };
  }
  return out;
}

export function valueText(d: Dimension, v: Value): string {
  if (d.kind === "boolean") return v ? "On" : "Off";
  const c = cellModel(d, v);
  return c.kind === "missing" ? "—" : c.text;
}

// ── Review: change summary, customers, cost exposure ──────────────────────────

export interface ChangeLine { key: string; label: string; before: string; after: string }

export function changeLines(dimensions: readonly Dimension[], before: Record<string, Value> | null, after: Record<string, Value>): ChangeLine[] {
  const a = validateEntitlementValues(after);
  if (!a.ok) return [];
  const b = before ? validateEntitlementValues(before) : null;
  const byKey = new Map(dimensions.map((d) => [d.key as string, d] as const));
  return diffEntitlementValues(b?.ok ? b.values : null, a.values).map((c) => {
    const d = byKey.get(c.key)!;
    return { key: c.key, label: PLAIN_LABEL[c.key] ?? c.label, before: c.before === null ? "—" : valueText(d, c.before), after: valueText(d, c.after) };
  });
}

export interface CostExposure {
  /** "Max estimated AI spend / day" for the draft. */
  after: string;
  /** Same for the current definition (null for a new group). */
  before: string | null;
  /** The sentence under the figure. */
  basis: string;
  measured: string;
}

export const ESTIMATED_CEILING_LABEL = "Estimated ceiling";

export function costExposure(detail: PolicyGroupDetailResponse | null, beforeUsd: number | null, afterUsd: number): CostExposure {
  const measured = detail?.cost.measuredNote ?? "Measured AI spend per policy group is not yet available.";
  if (!detail) {
    return { after: money(0), before: null, basis: "No customers on a new group yet — max estimated AI spend / day starts at $0.", measured };
  }
  const platform = detail.cost.platformAllowanceUsd;
  const a = estimateAllowanceCeiling(detail.assignments.buckets, afterUsd, platform);
  const b = beforeUsd === null ? null : estimateAllowanceCeiling(detail.assignments.buckets, beforeUsd, platform);
  const who = `${n(a.customers)} customer${a.customers === 1 ? "" : "s"} × daily AI allowance`;
  const not = a.notFollowingGroup > 0
    ? ` · ${n(a.notFollowingGroup)} follow an override, overlay or the platform setting instead of this group`
    : "";
  return { after: money(a.ceilingUsdPerDay), before: b ? money(b.ceilingUsdPerDay) : null, basis: `${who}${not}`, measured };
}

/** How many customers an edit reaches (assignments naming the group, plus unassigned customers resolving to the default). */
export function customersAffectedLine(detail: PolicyGroupDetailResponse | null): string {
  if (!detail) return "No customers are assigned to a new group.";
  const a = detail.assignments;
  const parts = [`${n(a.customers)} customer${a.customers === 1 ? "" : "s"} assigned`];
  if (a.withFounder > 0) parts.push(`${n(a.withFounder)} with Founder`);
  if (a.unassignedResolvingHere > 0) parts.push(`${n(a.unassignedResolvingHere)} unassigned resolve here`);
  return parts.join(" · ");
}

// ── Lifecycle words ───────────────────────────────────────────────────────────

export const DEFAULT_NOTE = "Affects new registrations only — existing assignments do not change.";
export const ARCHIVE_NOTE = "Archived groups can no longer be assigned. Nothing is deleted.";

/** Why archive is not offered right now, or null when it is. */
export function archiveBlocker(detail: PolicyGroupDetailResponse | null): string | null {
  if (!detail) return null;
  if (detail.group.archived) return "Already archived.";
  if (detail.group.isDefault) return "The default group cannot be archived — make another group the default first.";
  if (detail.group.builtIn) return "Built-in groups cannot be archived.";
  if (detail.assignments.customers > 0) {
    const c = detail.assignments.customers;
    return `${n(c)} customer${c === 1 ? " is" : "s are"} assigned — reassign in Customer Success first.`;
  }
  if (detail.group.source !== "DB") return "This group is defined in code only.";
  return null;
}

/** Why "Make default" is not offered right now, or null when it is. */
export function defaultBlocker(detail: PolicyGroupDetailResponse | null): string | null {
  if (!detail) return null;
  if (detail.group.isDefault) return "Already the default.";
  if (detail.group.archived) return "An archived group cannot be the default.";
  if (!detail.group.valid) return "The stored definition is invalid.";
  if (detail.group.source !== "DB") return "This group is defined in code only.";
  return null;
}

export function versionSummaryText(summary: Record<string, unknown>): string {
  const kind = String(summary.kind ?? "");
  const changes = Array.isArray(summary.changes) ? summary.changes.length : 0;
  // Entitlement changes first; a version that only renamed / redescribed says that instead of "0 changes".
  const textOnly = [summary.label ? "renamed" : null, summary.descriptionChanged ? "description edited" : null].filter(Boolean).join(" · ");
  const dims = changes === 0 && textOnly ? textOnly : `${n(changes)} change${changes === 1 ? "" : "s"}`;
  switch (kind) {
    case "SEEDED": return "Seeded from the code catalogue";
    case "CREATED": return summary.from ? `Created from ${String(summary.from)} · ${dims}` : `Created · ${dims}`;
    case "ROLLED_BACK": return `Restored version ${String(summary.restoredVersion ?? "?")} · ${dims}`;
    case "UPDATED": return `Edited · ${dims}${changes > 0 && summary.label ? " · renamed" : ""}`;
    default: return dims;
  }
}

/** The outcome line after a write answered (status + body). */
export function writeOutcome(status: number, body: { error?: string; version?: number; errors?: string[] }): { text: string; tone: StatusTone } {
  if (status === 200 || status === 201) return { text: body.version ? `Saved as version ${body.version}` : "Saved", tone: "ok" };
  const detail = body.errors?.length ? ` — ${body.errors[0]}` : "";
  return { text: `${body.error ?? `Not saved (HTTP ${status})`}${detail}`, tone: status === 409 ? "warn" : "bad" };
}

/** The values a mode starts from. */
export function initialDraft(mode: EditorMode, data: PolicyGroupsResponse, detail: PolicyGroupDetailResponse | null): EditorDraft | null {
  const byKey = (k: string) => data.policyGroups.find((g) => g.key === k);
  switch (mode.kind) {
    case "edit": {
      const g = byKey(mode.key);
      return g ? { key: g.key, label: g.label, description: g.description, values: { ...g.values } } : null;
    }
    case "new": {
      const g = data.policyGroups.find((x) => x.isDefault);
      return g ? { key: "", label: "", description: "", values: { ...g.values } } : null;
    }
    case "clone": {
      const g = byKey(mode.from);
      return g ? { key: "", label: `${g.label} (copy)`.slice(0, 60), description: g.description, values: { ...g.values } } : null;
    }
    case "restore": {
      const v = detail?.versions.find((x) => x.version === mode.toVersion);
      return v?.values ? { key: mode.key, label: v.label, description: detail?.group.description ?? "", values: { ...v.values } } : null;
    }
  }
}

export type { EntitlementValues };
