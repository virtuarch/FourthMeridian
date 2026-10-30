"use client";

/**
 * components/platform/widgets/CsCustomersWidget.tsx  (P1 · cs_customers)
 *
 * THE CUSTOMER SUCCESS CUSTOMER SPINE. One list, one selected customer, every
 * question an authorized operator needs answered from one context:
 * identity · cohort & policy (effective entitlements WITH provenance) · beta
 * lifecycle · Spaces · activity · connections & health · incidents · AI usage
 * (estimate) · operator actions · the safe actions available.
 *
 * Reads: GET /customer-success/customers, GET /customer-success/customers/[id].
 * Writes (fresh CUSTOMER_SUCCESS WRITE, every one audited with a structured
 * reason where consequential): POST …/policy, …/cohort, …/refresh, …/access
 * (deactivate / reactivate — SEC-PLAT-4 moved it here from GROWTH_REVENUE).
 * Invite resend stays on its GROWTH_REVENUE route.
 *
 * AI COST CONTROLS — beside the overlay select, "Daily AI allowance override
 * (USD)": a whole-dollar input + Set override / Remove override, posting ONLY
 * `{ aiDailyUsdAllowanceOverride: number | null, reason }` to …/policy (group
 * and overlay are never mixed into that call). The effective allowance and its
 * source are read from `policy.aiDailyAllowance` + `policy.aiDailyUsdAllowanceOverride`
 * and degrade to an honest sentence when it does not. Integer ≥ 1 is checked
 * here; the ceiling is the server's refusal and its sentence is shown.
 *
 * UI-001 — the editors (policy, allowance override, cohort) and Refresh all are
 * rendered only for a CUSTOMER_SUCCESS WRITE holder (`access.canWrite`); a READ
 * holder sees one explanatory line instead of buttons that 403. SEC-PLAT-4 —
 * deactivate / reactivate follows the same CUSTOMER_SUCCESS WRITE rule.
 * UI-002 — no fabricated audit reason: deactivate / reactivate posts the reason
 * the operator CHOSE and is disabled until one is chosen (the route refuses a
 * missing reason with a 400; the client no longer substitutes SUPPORT_REQUEST).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, RefreshCw, Loader2, ShieldCheck, Layers } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, WidgetStat, fmtUtc, timeAgo, type PlatformSection } from "../widget-kit";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import type { CustomerListResponse } from "@/app/api/platform/customer-success/customers/route";
import type { CustomerDetailResponse } from "@/app/api/platform/customer-success/customers/[userId]/route";
import { describeRefreshOutcomes, type RefreshAllReport } from "@/lib/refresh/outcomes";
import { operatorDisplayName } from "@/lib/platform/customer/identity-label";
import { COHORTS, OVERLAYS, POLICY_GROUPS } from "@/lib/entitlements/catalogue";
import { OPERATOR_REASON_CODES } from "@/lib/audit";
import { ROLLUP_NOTE, rollupCells, type CustomerRollupFields } from "./cs-rollup-view";
import { allowanceEffectiveText, allowanceOverrideBody, validateAllowanceOverrideInput, type AllowanceEffectiveView } from "./ai-cost-controls-view";

/**
 * AI COST CONTROLS — the effective allowance as CustomerPolicyView carries it
 * (`aiDailyAllowance { usd, source, … }` + `aiDailyUsdAllowanceOverride`), folded
 * into the editor's one view. Guarded so a response without the fields still
 * renders (the editor then says the build does not report it).
 */
function allowanceOf(policy: CustomerDetailResponse["policy"]): AllowanceEffectiveView | undefined {
  const p = policy as Partial<CustomerDetailResponse["policy"]>;
  if (!p.aiDailyAllowance || typeof p.aiDailyAllowance.usd !== "number") return undefined;
  return { usd: p.aiDailyAllowance.usd, source: p.aiDailyAllowance.source, override: p.aiDailyUsdAllowanceOverride ?? null };
}

/** A list row as the route serves it today, plus the W3 roll-up fields (optional until W3 merges). */
type CustomerRow = CustomerListResponse["customers"][number] & CustomerRollupFields;

const REASON_LABEL: Record<string, string> = {
  BETA_ONBOARDING: "Beta onboarding", SUPPORT_REQUEST: "Support request", DOGFOOD: "Dogfood", TESTING: "Testing",
  POLICY_ROLLOUT: "Policy rollout", INCIDENT: "Incident", ABUSE: "Abuse", OTHER: "Other",
};

const SOURCE_TONE: Record<string, string> = {
  POLICY: "var(--text-secondary)", POLICY_DEFAULT: "var(--text-muted)", OVERLAY: "var(--accent-warning)", CEILING: "var(--accent-positive)",
  USER_OVERRIDE: "var(--accent-warning)", PLATFORM_SETTING: "var(--text-secondary)",
  // FAIL CLOSED (owner ruling, 2026-10-30) — a missing/invalid assignment's restricted value.
  FAIL_CLOSED: "var(--accent-negative)",
};

function fmtValue(v: boolean | number): string { return typeof v === "boolean" ? (v ? "on" : "off") : String(v); }
function ago(iso: string | null): string { return iso ? `${timeAgo(iso)} ago` : "—"; }

/** UI-001 — the one line a READ holder sees where the editors would be. */
export const CS_READ_ONLY_LINE =
  "Changing policy, the AI allowance or cohorts, and Refresh all, need WRITE access to Customer Success.";

export function CsCustomersWidget({ section, access }: { section: PlatformSection; access?: SpaceMountAccess }) {
  // UI-001 — descriptive only (the server gate decides); absent ⇒ READ (fail-safe).
  const canWrite = access?.canWrite === true;
  const [list, setList] = useState<CustomerListResponse | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CustomerDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [refreshReport, setRefreshReport] = useState<RefreshAllReport | null>(null);
  /** UI-009 — when the list was last read (every refetch moves it). */
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  /** ONE instant for the list's relative times, captured at mount (a clock read during render is impure). */
  const [nowMs] = useState(() => Date.now());

  // Assignment forms
  const [policyGroup, setPolicyGroup] = useState<string>("");
  const [overlay, setOverlay] = useState<string>("");
  const [cohort, setCohort] = useState<string>("");
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reasonNote, setReasonNote] = useState<string>("");
  /** AI COST CONTROLS — the override input as typed (raw); nothing posts while typing. */
  const [allowanceInput, setAllowanceInput] = useState<string>("");

  const loadList = useCallback(async (q: string) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/platform/customer-success/customers?search=${encodeURIComponent(q)}&limit=100`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setList((await r.json()) as CustomerListResponse);
      setLoadedAt(new Date().toISOString());
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setLoading(false); }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true); setActionError(null);
    try {
      const r = await fetch(`/api/platform/customer-success/customers/${id}`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      const d = (await r.json()) as CustomerDetailResponse;
      setDetail(d); setPolicyGroup(d.policy.policyGroup); setOverlay(d.policy.overlay ?? "");
      const allowance = allowanceOf(d.policy);
      setAllowanceInput(allowance?.override != null ? String(allowance.override) : "");
    } catch (e) { setActionError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { let alive = true; (async () => { if (alive) await loadList(""); })(); return () => { alive = false; }; }, [loadList]);
  useEffect(() => {
    if (!selectedId) return;
    let alive = true; (async () => { if (alive) await loadDetail(selectedId); })(); return () => { alive = false; };
  }, [selectedId, loadDetail]);

  /** Selection is the one place the detail state changes hands (no setState in an effect). */
  const select = (id: string | null) => { setSelectedId(id); setDetail(null); setRefreshReport(null); setActionError(null); setCohort(""); setReasonCode(""); setReasonNote(""); };

  const reason = useMemo(() => (reasonCode ? { code: reasonCode, ...(reasonNote.trim() ? { note: reasonNote.trim() } : {}) } : null), [reasonCode, reasonNote]);

  async function run(key: string, url: string, init: RequestInit, onDone?: (body: unknown) => void) {
    setActing(key); setActionError(null);
    try {
      const r = await fetch(url, { credentials: "same-origin", ...init });
      const isJson = (r.headers.get("content-type") ?? "").includes("application/json");
      const body = isJson ? await r.json().catch(() => ({})) : {};
      if (!r.ok) {
        // A refusal that never reached a Fourth Meridian handler (an expired
        // deployment-protection or app session, a stale tab after a deploy) comes
        // back as HTML, not JSON. Say so, with the status, instead of a generic line.
        const reason = (body as { error?: string }).error
          ?? (r.status === 403 ? "Not authorized for this action"
          : r.status === 401 ? "Your session is no longer valid here — reload and sign in again"
          : !isJson ? `The request did not reach Fourth Meridian (HTTP ${r.status}) — reload the page and try again`
          : `Action failed (${r.status})`);
        throw new Error(reason);
      }
      onDone?.(body);
      if (selectedId) await loadDetail(selectedId);
      await loadList(search);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(null); }
  }

  const json = (payload: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const assignPolicy = () => detail && reason && run("policy", `/api/platform/customer-success/customers/${detail.identity.id}/policy`,
    json({ policyGroup, overlay: overlay === "" ? null : overlay, reason }));
  // AI COST CONTROLS — the override posts on its own: only the override and the reason.
  const allowance = detail ? allowanceOf(detail.policy) : undefined;
  const allowanceCheck = validateAllowanceOverrideInput(allowanceInput);
  const dirty = detail !== null && (policyGroup !== detail.policy.policyGroup
    || overlay !== (detail.policy.overlay ?? "")
    || allowanceInput !== (allowance?.override != null ? String(allowance.override) : "")
    || cohort !== "" || reasonCode !== "" || reasonNote !== "");
  const setAllowanceOverride = () => detail && reason && allowanceCheck.value !== null && run("allowance", `/api/platform/customer-success/customers/${detail.identity.id}/policy`,
    json(allowanceOverrideBody(allowanceCheck.value, reason)));
  const removeAllowanceOverride = () => detail && reason && run("allowance", `/api/platform/customer-success/customers/${detail.identity.id}/policy`,
    json(allowanceOverrideBody(null, reason)), () => setAllowanceInput(""));
  const addCohort = () => detail && reason && cohort && run("cohort", `/api/platform/customer-success/customers/${detail.identity.id}/cohort`,
    json({ cohort, reason }), () => { setCohort(""); });
  const refreshAll = () => {
    if (!detail) return;
    setRefreshReport(null); // never let the previous outcome pose as this click's result
    void run("refresh", `/api/platform/customer-success/customers/${detail.identity.id}/refresh`, { method: "POST" },
      (body) => setRefreshReport(body as RefreshAllReport));
  };
  // UI-002 — the operator's chosen reason or nothing: no fallback code is invented.
  const toggleActive = () => detail?.actions.deactivate && reason && run("active", detail.actions.deactivate.url,
    json({ action: detail.actions.deactivate.currently === "ACTIVE" ? "deactivate" : "reactivate", reason }));

  return (
    <PlatformWidgetCard label={section.label} icon={Users} checkedAt={loadedAt}>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void loadList(search); }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email or name" aria-label="Search customers by email or name"
          className="w-full rounded-[var(--radius-sm)] border bg-transparent px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)]"
          style={{ borderColor: "var(--border-hairline)" }} />
        <button type="submit" className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold" style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>Search</button>
      </form>

      {loading && <WidgetMessage loading />}
      {error && <WidgetMessage error={error} />}
      {!loading && !error && list && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <WidgetStat value={list.total} label="Customers" />
            <WidgetStat value={list.customers.filter((c) => c.connectionCount > 0).length} label="Connected" />
            <WidgetStat value={list.customers.filter((c) => c.deactivatedAt).length} label="Deactivated" />
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">{ROLLUP_NOTE}</p>
          {list.customers.length === 0 ? <WidgetMessage empty="No customers match." /> : (
            <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
              {list.customers.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => select(c.id)}
                    className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[var(--text-primary)]">{operatorDisplayName(c)}</span>
                      <span className="truncate text-[11px] text-[var(--text-muted)]">
                        {c.policyGroup}{c.overlay ? ` + ${c.overlay}` : ""}{c.policyAssigned ? "" : " (default)"} · {c.cohorts.length ? c.cohorts.join(", ") : "no cohort"} · {c.connectionCount} connection{c.connectionCount === 1 ? "" : "s"}
                      </span>
                      {/* BETA — the per-user roll-up (W3 fields, optional until merged): every column word stays visible, an absent field is a dash. */}
                      <span className="flex flex-wrap gap-x-2 text-[11px] tabular-nums text-[var(--text-muted)]">
                        {rollupCells(c as CustomerRow, nowMs).map((cell, i) => (
                          <span key={cell.key}>{i > 0 ? "· " : ""}<span className="text-[var(--text-faint)]">{cell.word}</span> {cell.value}</span>
                        ))}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-[var(--text-muted)]">{c.deactivatedAt ? "deactivated" : `active ${ago(c.lastActiveAt)}`}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <RightPanel open={selectedId != null} dirty={dirty} onClose={() => select(null)} ariaLabel="Customer detail">
        {selectedId && (
          <>
            <PanelHeader eyebrow="Customer" title={detail?.identity.email ?? "…"} />
            <PanelContent>
              {detailLoading && <WidgetMessage loading />}
              {actionError && <WidgetMessage error={actionError} />}
              {detail && (
                <div className="flex flex-col gap-4 text-xs">
                  <Section title="Identity">
                    <Row label="Username" value={detail.identity.username ?? "— (none recorded)"} />
                    <Row label="Name" value={detail.identity.name ?? "—"} />
                    <Row label="Email" value={detail.identity.email} />
                    <Row label="Role" value={detail.identity.role} />
                    <Row label="Registered" value={ago(detail.identity.createdAt)} />
                    <Row label="Email verified" value={detail.identity.emailVerifiedAt ? "yes" : "no"} />
                    <Row label="State" value={detail.identity.deactivatedAt ? (detail.identity.deletionScheduledAt ? `deletion scheduled ${ago(detail.identity.deletionScheduledAt).replace(" ago", "")}` : "deactivated") : "active"} />
                    <Row label="Last active" value={`${ago(detail.activity.lastActiveAt)} (${detail.activity.lastActiveSource.toLowerCase()})`} />
                    {/* UI-009 — the instant every relative age in this panel is measured from. */}
                    <Row label="Detail checked" value={fmtUtc(detail.checkedAt)} />
                    <Row label="Sessions" value={String(detail.activity.activeSessions)} />
                  </Section>

                  <Section title="Cohort & policy">
                    <Row label="Cohorts" value={detail.cohorts.length ? detail.cohorts.map((c) => `${c.label} (${c.source.toLowerCase()}, ${ago(c.joinedAt)})`).join("; ") : "none recorded"} />
                    <Row label="Policy group" value={`${detail.policy.policyGroupLabel}${detail.policy.assigned || detail.policy.failClosed ? "" : " — default, no assignment recorded"}`} />
                    {detail.policy.failClosed && <Row label="Fail closed" value={detail.policy.failClosedReason === "UNASSIGNED" ? "No assignment recorded — assign a policy group below to restore the plan." : "The assigned key is not a policy group — assign a valid one below to restore the plan."} />}
                    {detail.policy.unknownPolicyGroup && <Row label="Assigned key unknown" value={detail.policy.unknownPolicyGroup} />}
                    <Row label="Overlay" value={detail.policy.overlayLabel ?? "none"} />
                    <ul className="mt-1 flex flex-col gap-1">
                      {detail.policy.dimensions.map((d) => (
                        <li key={d.key} className="flex items-center justify-between gap-2" title={d.explanation}>
                          <span className="text-[var(--text-secondary)]">{d.label}</span>
                          <span className="flex items-center gap-2">
                            <span className="text-[var(--text-primary)] tabular-nums">{fmtValue(d.value)}</span>
                            <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ color: SOURCE_TONE[d.source] ?? "var(--text-muted)", border: "1px solid var(--border-hairline)" }}>{d.source.replace("_", " ").toLowerCase()}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {/* UI-001 — editors only for a CUSTOMER_SUCCESS WRITE holder. */}
                    {!canWrite && <p className="mt-2 text-[11px] leading-snug text-[var(--text-muted)]" data-read-only-line>{CS_READ_ONLY_LINE}</p>}
                    {canWrite && (<>
                    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Change policy</p>
                      <label className="flex items-center justify-between gap-2"><span className="text-[var(--text-secondary)]">Group</span>
                        <select value={policyGroup} onChange={(e) => setPolicyGroup(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
                          {/* POLICY EDITOR — the server's assignable list (code + valid, non-archived DB groups); the code catalogue if absent. */}
                          {(detail.assignablePolicyGroups ?? Object.values(POLICY_GROUPS)).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                        </select></label>
                      <label className="flex items-center justify-between gap-2"><span className="text-[var(--text-secondary)]">Overlay</span>
                        <select value={overlay} onChange={(e) => setOverlay(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
                          <option value="">none</option>
                          {Object.values(OVERLAYS).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
                        </select></label>
                      <ReasonFields code={reasonCode} note={reasonNote} setCode={setReasonCode} setNote={setReasonNote} />
                      <button type="button" onClick={assignPolicy} disabled={acting !== null || !reason}
                        className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                        style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                        {acting === "policy" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />} Apply policy
                      </button>
                    </div>
                    {/* AI COST CONTROLS — the per-customer allowance override, its own call, the same reason fields. */}
                    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Daily AI allowance override (USD)</p>
                      <Row label="Effective allowance" value={allowanceEffectiveText(allowance)} />
                      <label className="flex items-center justify-between gap-2"><span className="text-[var(--text-secondary)]">Override</span>
                        <input type="number" min={1} step={1} value={allowanceInput} onChange={(e) => setAllowanceInput(e.target.value)} placeholder="whole dollars per UTC day"
                          aria-label="Daily AI allowance override (USD)" aria-invalid={allowanceInput !== "" && allowanceCheck.error !== null}
                          className="w-40 rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)]" style={{ borderColor: "var(--border-hairline)" }} /></label>
                      {allowanceInput !== "" && allowanceCheck.error && <p className="text-[11px]" role="alert" style={{ color: "var(--coral-400)" }}>{allowanceCheck.error}</p>}
                      <p className="text-[10px] leading-snug text-[var(--text-muted)]">Takes precedence over the overlay, the platform setting and the policy group; the catalogue ceiling clamps last and the server refuses a value above it. Estimated USD per UTC day, never a bill.</p>
                      <ReasonFields code={reasonCode} note={reasonNote} setCode={setReasonCode} setNote={setReasonNote} />
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={setAllowanceOverride} disabled={acting !== null || !reason || allowanceCheck.value === null}
                          className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                          style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                          {acting === "allowance" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ShieldCheck size={13} aria-hidden />} Set override
                        </button>
                        {allowance?.override != null && (
                          <button type="button" onClick={removeAllowanceOverride} disabled={acting !== null || !reason}
                            className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                            style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                            Remove override
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Add to cohort</p>
                      <select value={cohort} onChange={(e) => setCohort(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
                        <option value="">choose a cohort</option>
                        {Object.values(COHORTS).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                      <ReasonFields code={reasonCode} note={reasonNote} setCode={setReasonCode} setNote={setReasonNote} />
                      <button type="button" onClick={addCohort} disabled={acting !== null || !reason || !cohort}
                        className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                        style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                        {acting === "cohort" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Layers size={13} aria-hidden />} Add cohort
                      </button>
                    </div>
                    </>)}
                  </Section>

                  <Section title="Beta lifecycle">
                    <Row label="Stage" value={detail.lifecycle.stage.toLowerCase()} />
                    {detail.lifecycle.request ? (
                      <>
                        <Row label="Requested" value={`${ago(detail.lifecycle.request.createdAt)}${detail.lifecycle.request.requestCount > 1 ? ` · ${detail.lifecycle.request.requestCount}×` : ""}`} />
                        <Row label="Request status" value={detail.lifecycle.request.status.toLowerCase()} />
                        <Row label="Invited" value={ago(detail.lifecycle.request.invitedAt)} />
                        <Row label="Invite email" value={detail.lifecycle.inviteEmail ? `${inviteEmailLabel(detail.lifecycle.inviteEmail.status)} · ${ago(detail.lifecycle.inviteEmail.at)}` : "no attempt recorded"} />
                        <Row label="Redeemed" value={ago(detail.lifecycle.request.redeemedAt)} />
                      </>
                    ) : <Row label="Request" value="no beta request on this address" />}
                    <Row label="Registered" value={ago(detail.lifecycle.registeredAt)} />
                    <Row label="First connection" value={ago(detail.lifecycle.firstConnectedAt)} />
                  </Section>

                  <Section title="Spaces">
                    {detail.spaces.length === 0 ? <p className="text-[var(--text-secondary)]">No Space membership.</p> : detail.spaces.map((s) => (
                      <Row key={s.id} label={`${s.name}${s.archived ? " (archived)" : ""}`} value={`${s.type.toLowerCase()} · ${s.role.toLowerCase()} · ${s.status.toLowerCase()}`} />
                    ))}
                  </Section>

                  <Section title="Connections & health">
                    {detail.connections.length === 0 ? <p className="text-[var(--text-secondary)]">No provider connections.</p> : detail.connections.map((c) => (
                      <Row key={c.id} label={c.label} value={`${c.healthState.toLowerCase()} · ${c.status.toLowerCase()}${c.errorCode ? ` · ${c.errorCode}` : ""} · synced ${ago(c.lastSyncedAt)}`} />
                    ))}
                  </Section>

                  <Section title="Incidents">
                    <Row label="Open incidents" value={String(detail.incidents.open.length)} />
                    {detail.incidents.open.slice(0, 5).map((i) => <Row key={i.id} label={i.kind.toLowerCase().replace(/_/g, " ")} value={i.account ? `${i.account} · last ${ago(i.lastOccurredAt)}` : `last ${ago(i.lastOccurredAt)}`} />)}
                    <Row label="Recent refreshes" value={detail.incidents.recentExecutions.slice(0, 5).map((e) => `${e.trigger.toLowerCase()} ${e.overallStatus.toLowerCase()} ${timeAgo(e.startedAt)}`).join(", ") || "none"} />
                    <Row label="Recent webhooks" value={detail.incidents.recentWebhooks.slice(0, 5).map((w) => `${w.webhookCode} → ${w.handling.toLowerCase()}`).join(", ") || "none"} />
                  </Section>

                  <Section title={`AI usage · last ${detail.ai.windowDays} days`}>
                    <Row label="Model calls" value={`${detail.ai.invocations} (${Object.entries(detail.ai.byOutcome).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ") || "none"})`} />
                    <Row label="Conversations" value={String(detail.ai.conversations)} />
                    <Row label="Tokens" value={`${detail.ai.promptTokens.toLocaleString()} in · ${detail.ai.completionTokens.toLocaleString()} out`} />
                    <Row label="Estimated spend" value={detail.ai.estimatedUsd === null ? "not priced" : `$${detail.ai.estimatedUsd.toFixed(2)} (estimate)`} />
                    <Row label="Last call" value={ago(detail.ai.lastCallAt)} />
                    {detail.ai.lastFailureAt && <Row label="Last failure" value={ago(detail.ai.lastFailureAt)} />}
                    <p className="text-[10px] leading-snug text-[var(--text-muted)]">{detail.ai.estimateNote}</p>
                  </Section>

                  <Section title="Operator actions">
                    {detail.operatorActions.length === 0 ? <p className="text-[var(--text-secondary)]">None recorded.</p> : detail.operatorActions.slice(0, 10).map((a) => (
                      <Row key={a.id} label={`${a.action.toLowerCase().replace(/_/g, " ")} · ${timeAgo(a.at)}`} value={`${a.reasonCode ? REASON_LABEL[a.reasonCode] ?? a.reasonCode : "—"}${a.note ? ` — ${a.note}` : ""}`} />
                    ))}
                  </Section>

                  {/* UI-002 — deactivate / reactivate carries the reason the operator chose. */}
                  {detail.actions.deactivate && canWrite && (
                    <Section title="Account access">
                      <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                        {detail.actions.deactivate.currently === "ACTIVE" ? "Deactivate" : "Reactivate"} is recorded in the audit log with the reason you choose here. It needs Customer Success WRITE access.
                      </p>
                      <ReasonFields code={reasonCode} note={reasonNote} setCode={setReasonCode} setNote={setReasonNote} />
                    </Section>
                  )}

                  {refreshReport && (
                    <Section title="Refresh all — outcomes">
                      <Row label="Considered" value={`${refreshReport.summary.considered} · started ${refreshReport.summary.started} · skipped ${refreshReport.summary.skipped} · refused ${refreshReport.summary.refused} · failed ${refreshReport.summary.failed}`} />
                      {refreshReport.outcomes.map((o) => <Row key={`${o.kind}:${o.id}`} label={o.label} value={`${o.decision.toLowerCase()}${o.reason ? ` · ${o.reason.toLowerCase().replace(/_/g, " ")}` : ""}${o.retryAfterSeconds ? ` · retry in ${Math.ceil(o.retryAfterSeconds / 60)}m` : ""}`} />)}
                      {refreshReport.outcomes.length === 0 && <p className="text-[var(--text-secondary)]">No eligible authority was considered.</p>}
                    </Section>
                  )}
                </div>
              )}
            </PanelContent>
            <PanelFooter>
              {/* P1 operability — a consequential action answers WHERE it was pressed. The
                  full per-authority list stays in the detail body; this is the same one-line
                  description the customer's own Refresh button shows. */}
              {acting === "refresh" && <p className="w-full text-[11px] text-[var(--text-muted)]">Refreshing every eligible authority…</p>}
              {actionError && acting === null && (
                <p className="w-full text-[11px]" role="alert" style={{ color: "var(--danger-400, #f87171)" }}>Last action failed: {actionError}</p>
              )}
              {refreshReport && acting !== "refresh" && (
                <p className="w-full text-[11px] text-[var(--text-primary)]" role="status">
                  Refresh all: {describeRefreshOutcomes(refreshReport.outcomes)}
                </p>
              )}
              {!reason && detail && <p className="w-full text-[10px] text-[var(--text-muted)]">Policy, cohort and account-access changes need a reason code (above).</p>}
              {detail?.actions.refreshAll && canWrite && (
                <button type="button" onClick={refreshAll} disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                  {acting === "refresh" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <RefreshCw size={13} aria-hidden />} Refresh all
                </button>
              )}
              {detail?.actions.deactivate && canWrite && (
                <button type="button" onClick={toggleActive} disabled={acting !== null || !reason}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                  {detail.actions.deactivate.currently === "ACTIVE" ? "Deactivate" : "Reactivate"}
                </button>
              )}
            </PanelFooter>
          </>
        )}
      </RightPanel>
    </PlatformWidgetCard>
  );
}

function inviteEmailLabel(status: string | null): string {
  switch (status) {
    case "sent": return "handed to provider (not delivery-confirmed)";
    case "captured": return "captured — not sent";
    case "error": return "failed";
    case "skipped": return "skipped";
    default: return "unknown";
  }
}

function ReasonFields({ code, note, setCode, setNote }: { code: string; note: string; setCode: (v: string) => void; setNote: (v: string) => void }) {
  return (
    <>
      <label className="flex items-center justify-between gap-2"><span className="text-[var(--text-secondary)]">Reason</span>
        <select value={code} aria-required="true" onChange={(e) => setCode(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
          <option value="">choose a reason</option>
          {OPERATOR_REASON_CODES.map((c) => <option key={c} value={c}>{REASON_LABEL[c] ?? c}</option>)}
        </select></label>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} placeholder="Note (optional, no personal data)" aria-label="Reason note (optional, no personal data)"
        className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)]" style={{ borderColor: "var(--border-hairline)" }} />
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-[var(--border-hairline)] pt-3 first:border-t-0 first:pt-0">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      <span className="min-w-0 break-words text-[var(--text-secondary)]">{label}</span>
      <span className="min-w-0 max-w-full break-words text-right text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
