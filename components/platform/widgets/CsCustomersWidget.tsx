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
 * reason where consequential): POST …/policy, …/cohort, …/refresh. Deactivate /
 * reactivate and invite resend stay on their existing GROWTH_REVENUE routes and
 * are offered as links through their own gates (a 403 is shown, not hidden).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Users, RefreshCw, Loader2, ShieldCheck, Layers } from "lucide-react";
import { PlatformWidgetCard, WidgetMessage, WidgetStat, timeAgo, type PlatformSection } from "../widget-kit";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import type { CustomerListResponse } from "@/app/api/platform/customer-success/customers/route";
import type { CustomerDetailResponse } from "@/app/api/platform/customer-success/customers/[userId]/route";
import type { RefreshAllReport } from "@/lib/refresh/outcomes";
import { COHORTS, OVERLAYS, POLICY_GROUPS } from "@/lib/entitlements/catalogue";
import { OPERATOR_REASON_CODES } from "@/lib/audit";

const REASON_LABEL: Record<string, string> = {
  BETA_ONBOARDING: "Beta onboarding", SUPPORT_REQUEST: "Support request", DOGFOOD: "Dogfood", TESTING: "Testing",
  POLICY_ROLLOUT: "Policy rollout", INCIDENT: "Incident", ABUSE: "Abuse", OTHER: "Other",
};

const SOURCE_TONE: Record<string, string> = {
  POLICY: "var(--text-secondary)", POLICY_DEFAULT: "var(--text-muted)", OVERLAY: "var(--accent-warning)", CEILING: "var(--accent-positive)",
};

function fmtValue(v: boolean | number): string { return typeof v === "boolean" ? (v ? "on" : "off") : String(v); }
function ago(iso: string | null): string { return iso ? `${timeAgo(iso)} ago` : "—"; }

export function CsCustomersWidget({ section }: { section: PlatformSection }) {
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

  // Assignment forms
  const [policyGroup, setPolicyGroup] = useState<string>("");
  const [overlay, setOverlay] = useState<string>("");
  const [cohort, setCohort] = useState<string>("");
  const [reasonCode, setReasonCode] = useState<string>("");
  const [reasonNote, setReasonNote] = useState<string>("");

  const loadList = useCallback(async (q: string) => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/platform/customer-success/customers?search=${encodeURIComponent(q)}&limit=100`, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 403 ? "Not authorized" : `Request failed (${r.status})`);
      setList((await r.json()) as CustomerListResponse);
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
    } catch (e) { setActionError(e instanceof Error ? e.message : "Failed to load"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { let alive = true; (async () => { if (alive) await loadList(""); })(); return () => { alive = false; }; }, [loadList]);
  useEffect(() => {
    if (!selectedId) return;
    let alive = true; (async () => { if (alive) await loadDetail(selectedId); })(); return () => { alive = false; };
  }, [selectedId, loadDetail]);

  /** Selection is the one place the detail state changes hands (no setState in an effect). */
  const select = (id: string | null) => { setSelectedId(id); setDetail(null); setRefreshReport(null); setActionError(null); };

  const reason = useMemo(() => (reasonCode ? { code: reasonCode, ...(reasonNote.trim() ? { note: reasonNote.trim() } : {}) } : null), [reasonCode, reasonNote]);

  async function run(key: string, url: string, init: RequestInit, onDone?: (body: unknown) => void) {
    setActing(key); setActionError(null);
    try {
      const r = await fetch(url, { credentials: "same-origin", ...init });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((body as { error?: string }).error ?? (r.status === 403 ? "Not authorized for this action" : `Action failed (${r.status})`));
      onDone?.(body);
      if (selectedId) await loadDetail(selectedId);
      await loadList(search);
    } catch (e) { setActionError(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(null); }
  }

  const json = (payload: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const assignPolicy = () => detail && reason && run("policy", `/api/platform/customer-success/customers/${detail.identity.id}/policy`,
    json({ policyGroup, overlay: overlay === "" ? null : overlay, reason }), () => { setReasonCode(""); setReasonNote(""); });
  const addCohort = () => detail && reason && cohort && run("cohort", `/api/platform/customer-success/customers/${detail.identity.id}/cohort`,
    json({ cohort, reason }), () => { setCohort(""); setReasonCode(""); setReasonNote(""); });
  const refreshAll = () => detail && run("refresh", `/api/platform/customer-success/customers/${detail.identity.id}/refresh`, { method: "POST" },
    (body) => setRefreshReport(body as RefreshAllReport));
  const toggleActive = () => detail?.actions.deactivate && run("active", detail.actions.deactivate.url,
    json({ action: detail.actions.deactivate.currently === "ACTIVE" ? "deactivate" : "reactivate", reason: reason ?? { code: "SUPPORT_REQUEST" } }));

  return (
    <PlatformWidgetCard label={section.label} icon={Users}>
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void loadList(search); }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by email or name"
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
          {list.customers.length === 0 ? <WidgetMessage empty="No customers match." /> : (
            <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
              {list.customers.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => select(c.id)}
                    className="flex w-full items-center justify-between gap-2 px-1 py-2 text-left text-xs transition-colors hover:bg-[var(--surface-hover)]">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[var(--text-primary)]">{c.email}</span>
                      <span className="truncate text-[11px] text-[var(--text-muted)]">
                        {c.policyGroup}{c.overlay ? ` + ${c.overlay}` : ""}{c.policyAssigned ? "" : " (default)"} · {c.cohorts.length ? c.cohorts.join(", ") : "no cohort"} · {c.connectionCount} connection{c.connectionCount === 1 ? "" : "s"}
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

      <RightPanel open={selectedId != null} onClose={() => select(null)} ariaLabel="Customer detail">
        {selectedId && (
          <>
            <PanelHeader eyebrow="Customer" title={detail?.identity.email ?? "…"} />
            <PanelContent>
              {detailLoading && <WidgetMessage loading />}
              {actionError && <WidgetMessage error={actionError} />}
              {detail && (
                <div className="flex flex-col gap-4 text-xs">
                  <Section title="Identity">
                    <Row label="Name" value={detail.identity.name ?? detail.identity.username ?? "—"} />
                    <Row label="Role" value={detail.identity.role} />
                    <Row label="Registered" value={ago(detail.identity.createdAt)} />
                    <Row label="Email verified" value={detail.identity.emailVerifiedAt ? "yes" : "no"} />
                    <Row label="State" value={detail.identity.deactivatedAt ? (detail.identity.deletionScheduledAt ? `deletion scheduled ${ago(detail.identity.deletionScheduledAt).replace(" ago", "")}` : "deactivated") : "active"} />
                    <Row label="Last active" value={`${ago(detail.activity.lastActiveAt)} (${detail.activity.lastActiveSource.toLowerCase()})`} />
                    <Row label="Sessions" value={String(detail.activity.activeSessions)} />
                  </Section>

                  <Section title="Cohort & policy">
                    <Row label="Cohorts" value={detail.cohorts.length ? detail.cohorts.map((c) => `${c.label} (${c.source.toLowerCase()}, ${ago(c.joinedAt)})`).join("; ") : "none recorded"} />
                    <Row label="Policy group" value={`${detail.policy.policyGroupLabel}${detail.policy.assigned ? "" : " — default, no assignment recorded"}`} />
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
                    <div className="mt-2 flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Change policy</p>
                      <label className="flex items-center justify-between gap-2"><span className="text-[var(--text-secondary)]">Group</span>
                        <select value={policyGroup} onChange={(e) => setPolicyGroup(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
                          {Object.values(POLICY_GROUPS).map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
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
                        {acting === "policy" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Apply policy
                      </button>
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
                        {acting === "cohort" ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />} Add cohort
                      </button>
                    </div>
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
                    {detail.incidents.open.slice(0, 5).map((i) => <Row key={i.id} label={i.kind.toLowerCase().replace(/_/g, " ")} value={`last ${ago(i.lastOccurredAt)}`} />)}
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
              {detail?.actions.refreshAll && (
                <button type="button" onClick={refreshAll} disabled={acting !== null}
                  className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                  style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                  {acting === "refresh" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh all
                </button>
              )}
              {detail?.actions.deactivate && (
                <button type="button" onClick={toggleActive} disabled={acting !== null}
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
        <select value={code} onChange={(e) => setCode(e.target.value)} className="rounded border bg-transparent px-2 py-1 text-xs text-[var(--text-primary)]" style={{ borderColor: "var(--border-hairline)" }}>
          <option value="">choose a reason</option>
          {OPERATOR_REASON_CODES.map((c) => <option key={c} value={c}>{REASON_LABEL[c] ?? c}</option>)}
        </select></label>
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} placeholder="Note (optional, no personal data)"
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
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-[var(--text-secondary)]">{label}</span>
      <span className="text-right text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
