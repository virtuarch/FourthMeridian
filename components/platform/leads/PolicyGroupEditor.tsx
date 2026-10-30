"use client";

/**
 * components/platform/leads/PolicyGroupEditor.tsx  (POLICY EDITOR — Phase 2)
 *
 * THE VISUAL POLICY-GROUP EDITOR. Owner ruling (2026-10-30): Platform
 * Operations' highest access level is required to create, edit, clone, archive
 * or otherwise modify customer policy groups, with an operator reason and an
 * audit trail. So:
 *
 *   GATING. `usePolicyGroupEditor(access, …)` offers ANY edit affordance only
 *   when the operator's resolved access carries `canControl` (descriptive — the
 *   server's FRESH check on every write route is the authority). Otherwise it
 *   returns no actions and no panel: read-only operators see the same cards and
 *   history with no Edit / New / Clone / Restore, not a disabled one.
 *
 *   EDIT → REVIEW → CONFIRM. A RightPanel (desktop) / full-height bottom sheet
 *   (mobile; the footer holds the actions):
 *     edit    sections per category · toggles for on/off entitlements · a
 *             stepper + slider against the ceiling ("of 25") for counts · a
 *             preset slider for floors ("fastest 15 min") · a live EFFECTIVE
 *             column (and "with Founder" when the group has Founder assignees),
 *             computed by THE resolver;
 *     review  the change summary (each changed entitlement before → after),
 *             customers affected (counts), COST EXPOSURE (customers × daily AI
 *             allowance, labelled an estimated ceiling; measured spend "not yet
 *             available"), the required OperatorReasonField, then Save.
 *   Archive and Make default live in the editor's overflow and go through the
 *   same reason + confirm step; Make default says it affects new registrations
 *   only. "Restore this version" (history) opens the review step of a rollback.
 *
 * Every rule is re-checked by the server (lib/platform/policies/policy-groups-write.ts);
 * this file never computes an entitlement of its own — the pure model
 * (policy-editor-model.ts) calls the server's pure modules.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Archive, ChevronLeft, Copy, Minus, MoreHorizontal, Pencil, Plus, Star } from "lucide-react";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import type { PolicyGroupDetailResponse } from "@/lib/platform/policies/policy-group-detail";
import { useSharedWidgetFetch, useSharedWidgetPublish } from "../workspace-session";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import { PolicyGroupHistoryView, groupDetailUrl } from "./PolicyGroupHistory";
import {
  ARCHIVE_NOTE, DEFAULT_NOTE, ESTIMATED_CEILING_LABEL, archiveBlocker, changeLines, clampInput, costExposure, customersAffectedLine,
  defaultBlocker, draftErrors, editorSections, effectivePreview, initialDraft, nearestPresetIndex, rowModel, step, suggestKey, writeOutcome,
  type EditorDraft, type EditorMode, type PreviewCell, type RowModel,
} from "./policy-editor-model";

export const POLICY_GROUPS_URL = "/api/platform/platform-ops/policy-groups";
export const CREATE_URL = `${POLICY_GROUPS_URL}/create`;

const PILL = "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8";
const PRIMARY = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-xs font-semibold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-9";
const ICON_BTN = "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--border-hairline)] text-[var(--text-secondary)] hover:bg-[var(--surface-inset)] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:h-8 lg:w-8";
const INPUT = "w-full min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2.5 py-2 text-xs text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]";
const H3 = "text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]";

type Dimension = PolicyGroupsResponse["dimensions"][number];
type Value = boolean | number;

// ── Controls ──────────────────────────────────────────────────────────────────

function Toggle({ row, onChange, disabled }: { row: Extract<RowModel, { kind: "toggle" }>; onChange: (v: boolean) => void; disabled: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={row.on} aria-label={row.label} disabled={disabled || (!row.allowed && !row.on)}
      onClick={() => onChange(!row.on)} data-toggle={row.key}
      className="relative inline-flex h-11 w-14 shrink-0 items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:h-7">
      <span className="relative inline-block h-5 w-9 rounded-full transition-colors"
        style={{ background: row.on ? TONE_COLOR.info : "var(--border-hairline-strong, var(--border-hairline))" }}>
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]" style={{ left: row.on ? 18 : 2 }} />
      </span>
    </button>
  );
}

function NumberControl({ row, onChange, disabled }: { row: Extract<RowModel, { kind: "count" | "floor" }>; onChange: (v: number) => void; disabled: boolean }) {
  const isFloor = row.kind === "floor";
  const sliderMax = isFloor ? row.presets.length - 1 : row.max;
  const sliderValue = isFloor ? nearestPresetIndex(row.presets, row.value) : row.value;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-number={row.key}>
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className={ICON_BTN} aria-label={`Decrease ${row.label}`} disabled={disabled || row.value <= row.min} onClick={() => onChange(step(row, -1))}><Minus size={13} aria-hidden /></button>
        <input type="number" inputMode="numeric" aria-label={row.label} className={`${INPUT} w-20 text-center tabular-nums`} disabled={disabled}
          min={row.min} max={row.max} value={row.value} onChange={(e) => onChange(clampInput(row, Number(e.target.value)))} />
        <button type="button" className={ICON_BTN} aria-label={`Increase ${row.label}`} disabled={disabled || row.value >= row.max} onClick={() => onChange(step(row, 1))}><Plus size={13} aria-hidden /></button>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] tabular-nums text-[var(--text-faint)]">{row.ceilingText}</span>
      </div>
      <input type="range" aria-label={`${row.label} slider`} min={0} max={sliderMax} step={1} value={sliderValue} disabled={disabled}
        onChange={(e) => onChange(isFloor ? row.presets[Number(e.target.value)] : Number(e.target.value))}
        className="h-6 w-full min-w-0 accent-[var(--meridian-400)]" />
    </div>
  );
}

function EffectiveCell({ cell, founder }: { cell: PreviewCell | undefined; founder: boolean }) {
  if (!cell) return <span className="text-[11px] text-[var(--text-faint)]">—</span>;
  return (
    <span className="flex min-w-0 flex-col text-[11px] tabular-nums" data-effective>
      <span className="truncate text-[var(--text-secondary)]">Effective {cell.text}{cell.changedByCeiling ? " (ceiling)" : ""}</span>
      {founder && cell.founderText !== null && <span className="truncate text-[var(--text-faint)]">With Founder {cell.founderText}</span>}
    </span>
  );
}

// ── The body (prop-driven; every step renders in a test) ──────────────────────

export type EditorStep = "edit" | "review" | "archive" | "default";

export interface PolicyEditorBodyProps {
  mode: EditorMode;
  step: EditorStep;
  data: PolicyGroupsResponse;
  detail: PolicyGroupDetailResponse | null;
  draft: EditorDraft;
  onDraft: (d: EditorDraft) => void;
  reason: OperatorReasonValue;
  onReason: (r: OperatorReasonValue) => void;
  busy: boolean;
  feedback: { text: string; tone: StatusTone } | null;
}

export function PolicyEditorBody(p: PolicyEditorBodyProps) {
  const sections = editorSections(p.data.dimensions);
  const showFounder = (p.detail?.assignments.withFounder ?? 0) > 0;
  const preview = useMemo(() => effectivePreview(p.data.dimensions, p.draft.values, showFounder), [p.data.dimensions, p.draft.values, showFounder]);
  const isNew = p.mode.kind === "new" || p.mode.kind === "clone";
  const set = (key: string, v: Value) => p.onDraft({ ...p.draft, values: { ...p.draft.values, [key]: v } });
  const errors = draftErrors(p.draft, p.mode);

  if (p.step === "archive" || p.step === "default") {
    return (
      <div className="flex min-w-0 flex-col gap-4" data-editor-step={p.step}>
        <p className="text-sm text-[var(--text-primary)]">
          {p.step === "archive" ? `Archive ${p.draft.label}?` : `Make ${p.draft.label} the default group?`}
        </p>
        <p className="text-xs text-[var(--text-muted)]" data-lifecycle-note>{p.step === "archive" ? ARCHIVE_NOTE : DEFAULT_NOTE}</p>
        <p className="text-[11px] text-[var(--text-muted)]">{customersAffectedLine(p.detail)}</p>
        <OperatorReasonField value={p.reason} onChange={p.onReason} disabled={p.busy} />
        {p.feedback && <p role="status" className="text-[11px]" style={{ color: TONE_COLOR[p.feedback.tone] }}>{p.feedback.text}</p>}
      </div>
    );
  }

  if (p.step === "review") {
    const modeKey = p.mode.kind === "edit" || p.mode.kind === "restore" ? p.mode.key : null;
    const current = modeKey ? p.data.policyGroups.find((g) => g.key === modeKey)?.values ?? null : null;
    const source = p.mode.kind === "clone" ? p.data.policyGroups.find((g) => g.key === (p.mode as { from: string }).from)?.values ?? null
      : p.mode.kind === "new" ? p.data.policyGroups.find((g) => g.isDefault)?.values ?? null : current;
    const lines = changeLines(p.data.dimensions, source, p.draft.values);
    const cost = costExposure(isNew ? null : p.detail, current ? Number(current.aiDailyUsdAllowance) : null, Number(p.draft.values.aiDailyUsdAllowance ?? 0));
    const currentGroup = modeKey !== null ? p.data.policyGroups.find((g) => g.key === modeKey) : undefined;
    const renamed = currentGroup !== undefined && current !== null && currentGroup.label !== p.draft.label;
    // A description-only edit is still a change — say so instead of "No entitlement changes".
    const redescribed = currentGroup !== undefined && current !== null && (currentGroup.description ?? "") !== (p.draft.description ?? "");
    return (
      <div className="flex min-w-0 flex-col gap-5" data-editor-step="review">
        <section aria-label="Change summary" className="flex min-w-0 flex-col gap-2">
          <h3 className={H3}>{isNew ? `New group · ${p.draft.key} (from ${p.mode.kind === "clone" ? p.mode.from : "the default"})` : p.mode.kind === "restore" ? `Restore version ${p.mode.toVersion}` : "Changes"}</h3>
          {lines.length === 0 && !renamed && !redescribed ? (
            <p className="text-[11px] text-[var(--text-muted)]">{isNew ? "Same values as its source." : "No entitlement changes."}</p>
          ) : (
            <ul aria-label="Changed entitlements" className="flex flex-col">
              {renamed && (
                <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-[var(--border-hairline)] py-1.5 text-[11px] first:border-t-0">
                  <span className="truncate text-[var(--text-secondary)]">Name</span>
                  <span className="truncate tabular-nums text-[var(--text-primary)]">{p.draft.label}</span>
                </li>
              )}
              {redescribed && (
                <li className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-[var(--border-hairline)] py-1.5 text-[11px] first:border-t-0" data-change="description">
                  <span className="truncate text-[var(--text-secondary)]">Description</span>
                  <span className="truncate text-[var(--text-primary)]">Edited</span>
                </li>
              )}
              {lines.map((l) => (
                <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-t border-[var(--border-hairline)] py-1.5 text-[11px] first:border-t-0" data-change={l.key}>
                  <span className="truncate text-[var(--text-secondary)]">{l.label}</span>
                  <span className="tabular-nums"><span className="text-[var(--text-faint)]">{l.before}</span> → <span className="text-[var(--text-primary)]">{l.after}</span></span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Customers affected" className="flex min-w-0 flex-col gap-1">
          <h3 className={H3}>Customers affected</h3>
          <p className="text-xs tabular-nums text-[var(--text-primary)]" data-customers-affected>{customersAffectedLine(isNew ? null : p.detail)}</p>
        </section>
        <section aria-label="Cost exposure" className="flex min-w-0 flex-col gap-1">
          <h3 className={H3}>Cost exposure</h3>
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <span className="text-base font-semibold tabular-nums text-[var(--text-primary)]" data-cost-after>{cost.after}</span>
            {cost.before !== null && cost.before !== cost.after && <span className="tabular-nums text-[var(--text-faint)]">was {cost.before}</span>}
            <span className="text-[11px] text-[var(--text-muted)]">{ESTIMATED_CEILING_LABEL} · max estimated AI spend / day</span>
          </p>
          <p className="text-[11px] text-[var(--text-muted)]">{cost.basis}</p>
          <p className="text-[11px] text-[var(--text-faint)]">{cost.measured}</p>
        </section>
        <OperatorReasonField value={p.reason} onChange={p.onReason} disabled={p.busy} />
        {p.feedback && <p role="status" className="text-[11px]" style={{ color: TONE_COLOR[p.feedback.tone] }}>{p.feedback.text}</p>}
      </div>
    );
  }

  // edit
  return (
    <div className="flex min-w-0 flex-col gap-6" data-editor-step="edit">
      <section aria-label="Group" className="flex min-w-0 flex-col gap-3">
        {isNew && (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] text-[var(--text-muted)]">Key (permanent)</span>
            <input className={`${INPUT} font-mono uppercase`} value={p.draft.key} disabled={p.busy} maxLength={48} placeholder="BETA_PLUS"
              onChange={(e) => p.onDraft({ ...p.draft, key: e.target.value.toUpperCase() })} />
          </label>
        )}
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-[var(--text-muted)]">Name</span>
          <input className={INPUT} value={p.draft.label} disabled={p.busy} maxLength={60}
            onChange={(e) => p.onDraft({ ...p.draft, label: e.target.value, ...(isNew && (p.draft.key === "" || p.draft.key === suggestKey(p.draft.label)) ? { key: suggestKey(e.target.value) } : {}) })} />
        </label>
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-[var(--text-muted)]">Description</span>
          <textarea className={`${INPUT} min-h-16 resize-y`} value={p.draft.description} disabled={p.busy} maxLength={280}
            onChange={(e) => p.onDraft({ ...p.draft, description: e.target.value })} />
        </label>
      </section>
      {sections.map((s) => (
        <section key={s.id} aria-label={s.label} className="flex min-w-0 flex-col gap-3" data-editor-section={s.id}>
          <h3 className={H3}>{s.label}</h3>
          <ul aria-label={`${s.label} entitlements`} className="flex flex-col gap-4">
            {s.dimensions.map((d: Dimension) => {
              const row = rowModel(d, p.draft.values[d.key]);
              return (
                <li key={d.key} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)] sm:gap-4" data-editor-row={d.key}>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <span className="min-w-0 truncate text-xs text-[var(--text-primary)]" title={d.description}>{row.label}</span>
                      {row.kind === "toggle"
                        ? <Toggle row={row} onChange={(v) => set(d.key, v)} disabled={p.busy} />
                        : <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--text-primary)]">{row.text}</span>}
                    </div>
                    {row.kind !== "toggle" && <NumberControl row={row} onChange={(v) => set(d.key, v)} disabled={p.busy} />}
                  </div>
                  <EffectiveCell cell={preview?.[d.key]} founder={showFounder} />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {errors.length > 0 && (
        <ul aria-label="Needs attention" className="flex flex-col gap-1" data-editor-errors>
          {errors.slice(0, 5).map((e) => <li key={e} className="text-[11px]" style={{ color: TONE_COLOR.warn }}>{e}</li>)}
        </ul>
      )}
      {p.feedback && <p role="status" className="text-[11px]" style={{ color: TONE_COLOR[p.feedback.tone] }}>{p.feedback.text}</p>}
    </div>
  );
}

// ── The panel (state + writes) ────────────────────────────────────────────────

async function send(url: string, method: "POST" | "PATCH", body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(url, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

function EditorPanel({ mode, data, onClose, onDone, onMode }: {
  mode: EditorMode;
  data: PolicyGroupsResponse;
  onClose: () => void;
  onDone: (text: string) => void;
  /** Switch mode (history → "Restore this version" reopens as a rollback review). */
  onMode: (m: EditorMode) => void;
}) {
  const detailKey = mode.kind === "edit" || mode.kind === "restore" ? mode.key : data.defaultPolicyGroup;
  const detailFetch = useSharedWidgetFetch<PolicyGroupDetailResponse>(groupDetailUrl(detailKey));
  const detail = mode.kind === "edit" || mode.kind === "restore" ? detailFetch.data : null;
  const publishGroups = useSharedWidgetPublish<PolicyGroupsResponse>(POLICY_GROUPS_URL);
  const publishDetail = useSharedWidgetPublish<PolicyGroupDetailResponse>(groupDetailUrl(detailKey));
  const [stepName, setStep] = useState<EditorStep>(mode.kind === "restore" ? "review" : "edit");
  const [edited, setEdited] = useState<EditorDraft | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; tone: StatusTone } | null>(null);
  const [menu, setMenu] = useState(false);
  const draft = edited ?? initialDraft(mode, data, detailFetch.data);
  const group = mode.kind === "edit" || mode.kind === "restore" ? data.policyGroups.find((g) => g.key === mode.key) : undefined;

  const refresh = useCallback(async () => {
    const read = async <T,>(url: string, publish: (d: T) => void) => {
      try { const r = await fetch(url, { credentials: "same-origin" }); if (r.ok) publish((await r.json()) as T); } catch { /* the previous answer stays */ }
    };
    await Promise.all([read(POLICY_GROUPS_URL, publishGroups), read(groupDetailUrl(detailKey), publishDetail)]);
  }, [publishGroups, publishDetail, detailKey]);

  const commit = useCallback(async () => {
    const why = reasonPayload(reason);
    if (!why || !draft) return;
    setBusy(true);
    setFeedback(null);
    try {
      const expectedVersion = detail?.group.version ?? group?.version ?? null;
      const res = stepName === "archive" ? await send(`${groupDetailUrl(draft.key)}/archive`, "POST", { reason: why })
        : stepName === "default" ? await send(`${groupDetailUrl(draft.key)}/default`, "POST", { reason: why, expectedDefaultKey: data.defaultPolicyGroup })
        : mode.kind === "restore" ? await send(`${groupDetailUrl(mode.key)}/rollback`, "POST", { reason: why, expectedVersion, toVersion: mode.toVersion })
        : mode.kind === "edit" ? await send(groupDetailUrl(mode.key), "PATCH", { reason: why, expectedVersion, values: draft.values, label: draft.label, description: draft.description })
        : await send(CREATE_URL, "POST", { reason: why, key: draft.key, label: draft.label, description: draft.description, from: mode.kind === "clone" ? mode.from : "DEFAULT", values: draft.values });
      const out = writeOutcome(res.status, res.body as { error?: string; version?: number; errors?: string[] });
      await refresh();
      if (res.status === 200 || res.status === 201) {
        onDone(stepName === "archive" ? `Archived ${draft.label}` : stepName === "default" ? `${draft.label} is now the default for new registrations` : `${draft.label}: ${out.text}`);
        return;
      }
      setFeedback(out);
    } catch (e) {
      setFeedback({ text: e instanceof Error ? e.message : "Not saved", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }, [reason, draft, detail, group, stepName, mode, data.defaultPolicyGroup, refresh, onDone]);

  if (!draft) return null;
  const errors = draftErrors(draft, mode);
  // An edit with nothing changed has nothing to review (the server would refuse "Nothing changed").
  const unchanged = mode.kind === "edit" && group !== undefined && group.label === draft.label && group.description === draft.description
    && Object.keys(draft.values).every((k) => draft.values[k] === group.values[k]);
  const title = mode.kind === "new" ? "New policy group" : mode.kind === "clone" ? `Clone ${group?.label ?? mode.from}`
    : mode.kind === "restore" ? `Restore ${group?.label ?? mode.key}` : `Edit ${group?.label ?? mode.key}`;
  const archiveWhy = archiveBlocker(detail);
  const defaultWhy = defaultBlocker(detail);
  const confirmLabel = stepName === "archive" ? "Archive group" : stepName === "default" ? "Make default"
    : mode.kind === "restore" ? `Restore as version ${(detail?.group.version ?? 0) + 1}` : mode.kind === "edit" ? `Save version ${(detail?.group.version ?? group?.version ?? 0) + 1}` : "Create group";

  const overflow: ReactNode = mode.kind === "edit" && stepName === "edit" ? (
    <span className="relative">
      <button type="button" className={ICON_BTN} aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><MoreHorizontal size={14} aria-hidden /></button>
      {menu && (
        <span role="menu" className="absolute right-0 top-12 z-10 flex w-64 flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--border-hairline)] bg-[var(--surface-raised,var(--surface-inset))] p-2 shadow-lg lg:top-10">
          <button type="button" role="menuitem" className={`${PILL} justify-start border-0`} disabled={defaultWhy !== null}
            onClick={() => { setMenu(false); setReason(EMPTY_OPERATOR_REASON); setStep("default"); }}><Star size={13} aria-hidden /> Make default</button>
          <span className="px-3 text-[10px] text-[var(--text-faint)]">{defaultWhy ?? DEFAULT_NOTE}</span>
          {/* Built-in groups are never archived (ruling) — no Archive item at all. */}
          {!detail?.group.builtIn && (<>
            <button type="button" role="menuitem" className={`${PILL} justify-start border-0`} disabled={archiveWhy !== null}
              onClick={() => { setMenu(false); setReason(EMPTY_OPERATOR_REASON); setStep("archive"); }} data-archive-item><Archive size={13} aria-hidden /> Archive</button>
            <span className="px-3 text-[10px] text-[var(--text-faint)]">{archiveWhy ?? ARCHIVE_NOTE}</span>
          </>)}
        </span>
      )}
    </span>
  ) : undefined;

  const reviewing = stepName !== "edit";
  return (
    <RightPanel open onClose={() => { if (!busy) onClose(); }} size="lg" preventClose={busy} dirty={edited !== null}>
      <PanelHeader eyebrow="Policies" title={title} actions={overflow} />
      <PanelContent>
        <PolicyEditorBody mode={mode} step={stepName} data={data} detail={detail} draft={draft} onDraft={setEdited}
          reason={reason} onReason={setReason} busy={busy} feedback={feedback} />
        {mode.kind === "edit" && stepName === "edit" && detail && (
          <div className="mt-8 border-t border-[var(--border-hairline)] pt-6">
            <PolicyGroupHistoryView detail={detail} loading={false} error={null}
              onRestore={(v) => onMode({ kind: "restore", key: mode.key, toVersion: v })} />
          </div>
        )}
      </PanelContent>
      <PanelFooter>
        <div className="flex w-full min-w-0 items-center justify-end gap-2">
          {reviewing && mode.kind !== "restore" && (
            <button type="button" className={`${PILL} mr-auto`} disabled={busy} onClick={() => { setFeedback(null); setStep("edit"); }}><ChevronLeft size={13} aria-hidden /> Back</button>
          )}
          <button type="button" className={PILL} disabled={busy} onClick={onClose}>Cancel</button>
          {reviewing ? (
            <button type="button" className={PRIMARY} style={{ background: stepName === "archive" ? TONE_COLOR.bad : "var(--meridian-500, #3b82f6)" }}
              disabled={busy || reasonPayload(reason) === null || (stepName === "review" && errors.length > 0)} onClick={() => { void commit(); }} data-confirm>
              {busy ? "Saving…" : confirmLabel}
            </button>
          ) : (
            <button type="button" className={PRIMARY} style={{ background: "var(--meridian-500, #3b82f6)" }}
              disabled={errors.length > 0 || unchanged} onClick={() => { setFeedback(null); setReason(EMPTY_OPERATOR_REASON); setStep("review"); }} data-review>
              Review changes
            </button>
          )}
        </div>
      </PanelFooter>
    </RightPanel>
  );
}

// ── The gate ──────────────────────────────────────────────────────────────────

export interface PolicyEditActions {
  onEdit: (key: string) => void;
  onClone: (key: string) => void;
  onNew: () => void;
  onRestore: (key: string, version: number) => void;
}

/**
 * Mounted by the Policies lead. Returns edit actions ONLY for an operator whose
 * access allows policy-group changes; otherwise `actions` is undefined and
 * `panel` is null (read-only operators see no edit affordance at all).
 */
export function usePolicyGroupEditor(access: SpaceMountAccess | undefined, data: PolicyGroupsResponse | null): {
  actions: PolicyEditActions | undefined;
  panel: ReactNode;
  status: ReactNode;
} {
  const offer = access?.canControl === true;
  const [mode, setMode] = useState<EditorMode | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const actions = useMemo<PolicyEditActions | undefined>(() => offer ? {
    onEdit: (key) => { setStatus(null); setMode({ kind: "edit", key }); },
    onClone: (from) => { setStatus(null); setMode({ kind: "clone", from }); },
    onNew: () => { setStatus(null); setMode({ kind: "new" }); },
    onRestore: (key, toVersion) => { setStatus(null); setMode({ kind: "restore", key, toVersion }); },
  } : undefined, [offer]);
  if (!offer) return { actions: undefined, panel: null, status: null };
  return {
    actions,
    panel: mode && data ? <EditorPanel key={JSON.stringify(mode)} mode={mode} data={data} onClose={() => setMode(null)} onDone={(t) => { setStatus(t); setMode(null); }} onMode={setMode} /> : null,
    status: status ? <span role="status" className="text-[11px]" style={{ color: TONE_COLOR.ok }} data-editor-status>{status}</span> : null,
  };
}

/** Small card affordances (Edit · Clone) — rendered by the lead only when actions exist. */
export function GroupEditButtons({ groupKey, label, actions, archived }: { groupKey: string; label: string; actions: PolicyEditActions; archived: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2" data-group-edit={groupKey}>
      {/* An archived group is retired: neither edited nor cloned (the server refuses both). */}
      {!archived && <button type="button" className={PILL} onClick={() => actions.onEdit(groupKey)} aria-haspopup="dialog" aria-label={`Edit ${label}`}><Pencil size={12} aria-hidden /> Edit</button>}
      {!archived && <button type="button" className={PILL} onClick={() => actions.onClone(groupKey)} aria-haspopup="dialog" aria-label={`Clone ${label}`}><Copy size={12} aria-hidden /> Clone</button>}
    </span>
  );
}

export function NewGroupButton({ actions }: { actions: PolicyEditActions }) {
  return <button type="button" className={PILL} onClick={actions.onNew} aria-haspopup="dialog" data-new-group><Plus size={12} aria-hidden /> New group</button>;
}
