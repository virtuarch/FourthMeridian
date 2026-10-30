"use client";

/**
 * components/platform/widgets/GrowthBetaRequestsWidget.tsx
 *   (Wave 1 S3 · growth_beta_requests · PO-3A read block · PO-3B write controls)
 *
 * The Growth & Revenue "Beta Access" OPERATING block. Reads:
 *   - GET /growth-revenue/beta-status → registration_mode + invitation lifecycle
 *   - GET /growth-revenue/requests     → counts + pending queue + approved invitations
 * and lets a GROWTH_REVENUE WRITE operator drive the whole lifecycle safely:
 *   - Beta mode control (open | invite_only | closed) — PUT /registration-mode, confirmed
 *   - Pending request → Approve / Deny  (existing WRITE routes)
 *   - Approved invitation → Resend / Revoke (PO-3B WRITE routes)
 * Every mutation goes through requireFreshPlatformAccess("GROWTH_REVENUE","WRITE")
 * server-side and lands an AuditLog row (→ Security Ops operator feed). Destructive
 * / high-impact actions (mode change, revoke) require an explicit ConfirmDialog.
 *
 * Manages its own fetch/action state (it mutates + refetches), reusing the shared
 * card shell + editorial idiom so it sits flush with the other platform widgets.
 *
 * UI-001 — every write control (status / mode toggles, Invite user, Approve /
 * Deny, Resend / Revoke) renders only for a GROWTH_REVENUE WRITE holder
 * (`access.canWrite`). A READ holder sees the same figures, the current status
 * and mode as text, and one explanatory line — never a button that 403s.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, X, Send, Ban, Loader2, ShieldAlert, UserPlus, Rocket, Search, ArrowUpDown, ChevronRight, Settings2 } from "lucide-react";
import { Block, Surface } from "@/components/atlas/Surface";
import {
  UtcStamp,
  WidgetMessage,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import { EMPTY_OPERATOR_REASON, OperatorReasonField, reasonPayload, type OperatorReasonValue } from "./OperatorReasonField";
import type {
  BetaRequestsResponse,
  BetaRequestRow,
  BetaInvitationRow,
} from "@/app/api/platform/growth-revenue/requests/route";
import type { BetaStatusResponse } from "@/app/api/platform/growth-revenue/beta-status/route";
import { describeAcquisitionSource } from "@/lib/marketing/acquisition";

type Mode = BetaStatusResponse["registrationMode"];
type ProductStatus = BetaStatusResponse["productStatus"];

const PRODUCT_STATUSES: { value: ProductStatus; label: string }[] = [
  { value: "development", label: "Development" },
  { value: "beta",        label: "Beta" },
  { value: "live",        label: "Live" },
];

/** Coarse "in 3d" / "in 5h" label for a FUTURE ISO time (timeAgo clamps the past). */
function until(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "soon";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

/**
 * The last invite EMAIL attempt, in words that never claim delivery: Fourth
 * Meridian records the provider hand-off (OPS-1 EmailResult), not a receipt.
 */
function inviteEmailLabel(o: BetaInvitationRow["inviteEmail"]): string {
  switch (o.status) {
    case "sent":     return "handed to provider (not delivery-confirmed)";
    case "captured": return "captured — not sent (no provider key)";
    case "error":    return "failed";
    case "skipped":  return "skipped (no recipient)";
    default:         return "unknown";
  }
}

/** Rows shown before "Show all" — keeps the list compact near the top of Growth. */
export const LIST_ROWS = 8;

const MODES: { value: Mode; label: string }[] = [
  { value: "open",        label: "Open" },
  { value: "invite_only", label: "Invite Only" },
  { value: "closed",      label: "Closed" },
];

const MODE_META: Record<Mode, { label: string; detail: string; tone: string }> = {
  open:        { label: "Open",        detail: "Anyone can create an account — no invite required.",        tone: "var(--accent-warning)" },
  invite_only: { label: "Invite Only", detail: "Beta is ON — an approved, email-bound invite is required.", tone: "var(--accent-positive)" },
  closed:      { label: "Closed",      detail: "Signup is disabled entirely.",                               tone: "var(--text-muted)" },
};

/** UI-001 — the one line a READ holder sees where the write controls would be. */
export const GROWTH_READ_ONLY_LINE =
  "Read-only — changing the status or signup mode, inviting, approving, denying, resending and revoking need WRITE access to Growth.";

export function GrowthBetaRequestsWidget({ section, access }: { section: PlatformSection; access?: SpaceMountAccess }) {
  // UI-001 — descriptive only (the server gate decides); absent ⇒ READ (fail-safe).
  const canWrite = access?.canWrite === true;
  const [reqs, setReqs]     = useState<BetaRequestsResponse | null>(null);
  const [status, setStatus] = useState<BetaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [acting, setActing]   = useState<string | null>(null); // id or "mode" while a mutation runs
  /** UI-009 — when the figures below were last read (every refetch moves it). */
  const [loadedAt, setLoadedAt] = useState<string | null>(null);

  const [selectedRequestId, setSelectedRequestId]       = useState<string | null>(null);
  const [selectedInvitationId, setSelectedInvitationId] = useState<string | null>(null);
  const [pendingMode, setPendingMode]                   = useState<Mode | null>(null); // mode-change confirm
  const [pendingStatus, setPendingStatus]               = useState<ProductStatus | null>(null); // product-status confirm
  const [revokeId, setRevokeId]                         = useState<string | null>(null); // revoke confirm
  const [inviteOpen, setInviteOpen]                     = useState(false); // direct-invite form
  const [inviteEmail, setInviteEmail]                   = useState("");
  const [inviteDays, setInviteDays]                     = useState("7");
  // PLATFORM SPACES 2.0 — the list's own view state (client-side over the rows the route returns).
  const [tab, setTab]                                   = useState<"pending" | "invited">("pending");
  const [query, setQuery]                               = useState("");
  // Waiting is first-in-first-out (oldest first); Invited reads newest first, as the route orders it.
  const [sort, setSort]                                 = useState<"newest" | "oldest">("oldest");
  const [showAll, setShowAll]                           = useState(false);
  const firstLoadDone                                   = useRef(false);
  const [settingsOpen, setSettingsOpen]                 = useState(false);
  // SEC-PLAT-2 — mode / status changes and revocation carry a required reason
  // (lib/audit.ts REASON_REQUIRED_ACTIONS); one value serves whichever confirm is open.
  const [reason, setReason]                             = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const closeConfirm = (close: () => void) => () => { close(); setReason(EMPTY_OPERATOR_REASON); };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rReq, rStatus] = await Promise.all([
        fetch("/api/platform/growth-revenue/requests", { credentials: "same-origin" }),
        fetch("/api/platform/growth-revenue/beta-status", { credentials: "same-origin" }),
      ]);
      if (!rReq.ok) throw new Error(rReq.status === 403 ? "Not authorized" : `Request failed (${rReq.status})`);
      const body = (await rReq.json()) as BetaRequestsResponse;
      setReqs(body);
      // First read only: open on the tab that has work in it (Waiting, unless it is empty and invitations are not).
      if (!firstLoadDone.current) {
        firstLoadDone.current = true;
        if (body.pending.length === 0 && body.invitations.length > 0) { setTab("invited"); setSort("newest"); }
      }
      if (rStatus.ok) setStatus((await rStatus.json()) as BetaStatusResponse);
      setLoadedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => { if (alive) await load(); })();
    return () => { alive = false; };
  }, [load]);

  /** Shared mutation runner: POST/PUT, surface the server error, refetch on success. */
  async function run(key: string, url: string, init: RequestInit, onDone?: () => void) {
    setActing(key);
    setError(null);
    try {
      const r = await fetch(url, { credentials: "same-origin", ...init });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body.error ?? `Action failed (${r.status})`);
      }
      onDone?.();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setActing(null);
    }
  }

  const changeMode = (mode: Mode) =>
    run("mode", "/api/platform/growth-revenue/registration-mode",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, reason: reasonPayload(reason) }) },
      closeConfirm(() => setPendingMode(null)));

  const changeStatus = (status: ProductStatus) =>
    run("status", "/api/platform/growth-revenue/product-status",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status, reason: reasonPayload(reason) }) },
      closeConfirm(() => setPendingStatus(null)));

  const sendInvite = () =>
    run("invite", "/api/platform/growth-revenue/invitations",
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), expiresDays: Number(inviteDays) || 7 }) },
      () => { setInviteOpen(false); setInviteEmail(""); setInviteDays("7"); });

  const decide = (id: string, action: "approve" | "deny") =>
    run(id, `/api/platform/growth-revenue/requests/${id}/${action}`, { method: "POST" },
      () => setSelectedRequestId(null));

  const resend = (id: string) =>
    run(id, `/api/platform/growth-revenue/requests/${id}/resend`, { method: "POST" });

  const revoke = (id: string) =>
    run(id, `/api/platform/growth-revenue/requests/${id}/revoke`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: reasonPayload(reason) }) },
      closeConfirm(() => { setRevokeId(null); setSelectedInvitationId(null); }));

  // Opening a panel starts from a clean slate: an earlier action's error never
  // appears inside an unrelated request or confirm.
  const openRequest = (id: string) => { setError(null); setSelectedRequestId(id); };
  const openInvitation = (id: string) => { setError(null); setSelectedInvitationId(id); };

  const selectedRequest: BetaRequestRow | null =
    selectedRequestId ? reqs?.pending.find((r) => r.id === selectedRequestId) ?? null : null;
  const selectedInvitation: BetaInvitationRow | null =
    selectedInvitationId ? reqs?.invitations.find((r) => r.id === selectedInvitationId) ?? null : null;

  const currentMode = status?.registrationMode;

  const q = query.trim().toLowerCase();
  const byTime = (a: string | null | undefined, b: string | null | undefined) =>
    (sort === "newest" ? -1 : 1) * ((a ? Date.parse(a) : 0) - (b ? Date.parse(b) : 0));
  const pendingRows = (reqs?.pending ?? [])
    .filter((r) => !q || r.email.toLowerCase().includes(q) || (describeAcquisitionSource(r.acquisition) ?? "").toLowerCase().includes(q))
    .sort((a, b) => byTime(a.createdAt, b.createdAt));
  const invitationRows = (reqs?.invitations ?? [])
    .filter((r) => !q || r.email.toLowerCase().includes(q))
    .sort((a, b) => byTime(a.invitedAt, b.invitedAt));
  const rowsShown = tab === "pending" ? pendingRows.length : invitationRows.length;
  // The route returns at most 100 rows per list — say so when the count is larger (search covers those rows only).
  const loadedRows = tab === "pending" ? reqs?.pending.length ?? 0 : reqs?.invitations.length ?? 0;
  const totalRows = tab === "pending" ? reqs?.counts.pending ?? 0 : reqs?.counts.approved ?? 0;
  const truncated = totalRows > loadedRows ? `showing ${loadedRows} of ${totalRows} (${tab === "pending" ? "oldest" : "newest"} first)` : null;
  const limit = showAll ? Infinity : LIST_ROWS;
  const TH = "px-2 py-2 text-left text-[10px] font-medium uppercase tracking-wide text-[var(--text-faint)]";
  const TD = "px-2 py-2.5 align-middle";

  return (
    <Block id="growth-beta-list" label={section.label} className="min-w-0"
      hint={currentMode ? (
        <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-[11px] text-[var(--text-secondary)] max-sm:hidden" data-signup-mode title={MODE_META[currentMode].detail}>
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: MODE_META[currentMode].tone }} />
          {`Signup ${MODE_META[currentMode].label.toLowerCase()}`}
          {status && <span className="text-[var(--text-muted)]">{`· ${PRODUCT_STATUSES.find((s) => s.value === status.productStatus)?.label ?? status.productStatus}`}</span>}
        </span>
      ) : undefined}
      action={
        <span className="flex items-center gap-1">
          <button type="button" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}
            className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8">
            <Settings2 size={12} aria-hidden /> Access
          </button>
          {canWrite && (
            <button type="button" onClick={() => setInviteOpen(true)} disabled={acting !== null}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 text-[11px] font-semibold text-[var(--text-primary)] disabled:opacity-40 lg:min-h-8"
              style={{ background: "var(--surface-inset)" }}>
              <UserPlus size={12} aria-hidden /> Invite
            </button>
          )}
        </span>
      }>
      <Surface className="flex min-w-0 flex-1 flex-col gap-3 p-4 sm:p-5">
        {loading && !reqs ? (
          <WidgetMessage loading={loading} error={error} />
        ) : !reqs ? (
          <WidgetMessage loading={false} error={error} />
        ) : (
          <>
            {/* While a panel or confirm is open the error is announced THERE (once). */}
            {error && !(selectedRequest || selectedInvitation || pendingMode || pendingStatus || revokeId) && (
              <p role="alert" className="text-[11px] text-[var(--accent-negative)]">{error}</p>
            )}

            {/* ── Access settings (status + signup mode), on demand ─────────── */}
            {settingsOpen && (
              <div className="grid gap-4 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3 sm:grid-cols-2" data-access-settings>
                {status && (
                  <div className="flex flex-col gap-2">
                    <span className="flex items-center gap-2">
                      <Rocket size={13} className="text-[var(--text-muted)]" aria-hidden />
                      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Platform status</span>
                    </span>
                    {!canWrite ? (
                      <span className="text-sm font-medium text-[var(--text-primary)]">
                        {PRODUCT_STATUSES.find((s) => s.value === status.productStatus)?.label ?? status.productStatus}
                      </span>
                    ) : (
                    <div className="inline-flex w-fit rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5" role="group" aria-label="Product status">
                      {PRODUCT_STATUSES.map((s) => {
                        const active = s.value === status.productStatus;
                        return (
                          <button key={s.value} type="button" disabled={acting !== null}
                            onClick={() => { if (!active) { setError(null); setPendingStatus(s.value); } }}
                            aria-pressed={active}
                            className="min-h-11 rounded-[calc(var(--radius-sm)-2px)] px-3 text-[11px] font-medium transition-colors disabled:opacity-40 lg:min-h-7"
                            style={active ? { background: "var(--surface-inset)", color: "var(--text-primary)" } : { color: "var(--text-secondary)" }}>
                            {s.label}
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </div>
                )}
                {currentMode && (
                  <div className="flex flex-col gap-2">
                    <span className="flex items-center gap-2">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: MODE_META[currentMode].tone }} aria-hidden />
                      <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Signup · {MODE_META[currentMode].label}</span>
                    </span>
                    <span className="text-[11px] text-[var(--text-muted)]">{MODE_META[currentMode].detail}</span>
                    {canWrite && (
                    <div className="inline-flex w-fit rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5" role="group" aria-label="Signup mode">
                      {MODES.map((m) => {
                        const active = m.value === currentMode;
                        return (
                          <button key={m.value} type="button" disabled={acting !== null}
                            onClick={() => { if (!active) { setError(null); setPendingMode(m.value); } }}
                            aria-pressed={active}
                            className="min-h-11 rounded-[calc(var(--radius-sm)-2px)] px-3 text-[11px] font-medium transition-colors disabled:opacity-40 lg:min-h-7"
                            style={active ? { background: "var(--surface-inset)", color: "var(--text-primary)" } : { color: "var(--text-secondary)" }}>
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                    )}
                  </div>
                )}
                {status && (
                  <p className="text-[11px] text-[var(--text-muted)] tabular-nums sm:col-span-2">
                    {`Invitations: ${status.invitations.sent} emailed · ${status.invitations.accepted} accepted · ${status.invitations.expired} expired · ${status.invitations.revoked} revoked`}
                  </p>
                )}
              </div>
            )}

            {/* ── Direct operator invite ───────────────────────────────────── */}
            {canWrite && inviteOpen && (
              <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-3" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }} data-invite-form>
                <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Invite a user directly</p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} aria-label="Invitee email"
                    placeholder="email@example.com" autoComplete="off"
                    className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-sm)] border bg-transparent px-2.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] lg:min-h-8"
                    style={{ borderColor: "var(--border-hairline)" }}
                  />
                  <label htmlFor="growth-invite-days" className="text-[11px] text-[var(--text-secondary)]">Expires in</label>
                  <input
                    id="growth-invite-days"
                    type="number" min={1} max={30} value={inviteDays} onChange={(e) => setInviteDays(e.target.value)}
                    className="min-h-11 w-16 rounded-[var(--radius-sm)] border bg-transparent px-2 text-xs tabular-nums text-[var(--text-primary)] lg:min-h-8"
                    style={{ borderColor: "var(--border-hairline)" }}
                  />
                  <span className="text-[11px] text-[var(--text-muted)]">days</span>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => { setInviteOpen(false); setInviteEmail(""); }} disabled={acting !== null}
                    className="min-h-11 rounded-[var(--radius-sm)] border px-3 text-xs font-semibold disabled:opacity-40 lg:min-h-8"
                    style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                    Cancel
                  </button>
                  <button type="button" onClick={sendInvite} disabled={acting !== null || !inviteEmail.trim()}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-xs font-semibold disabled:opacity-40 lg:min-h-8"
                    style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                    {acting === "invite" ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Send size={13} aria-hidden />} Send invite
                  </button>
                  <span className="min-w-0 truncate text-[10px] text-[var(--text-muted)]">Email-bound, single-use. No transferable link.</span>
                </div>
              </div>
            )}

            {/* UI-001 — a READ holder is told why there are no controls. */}
            {!canWrite && (
              <p className="text-[11px] leading-snug text-[var(--text-muted)]" data-read-only-line>{GROWTH_READ_ONLY_LINE}</p>
            )}

            {/* < sm — the signup mode, which the header hint hides at phone width. */}
            {currentMode && (
              <p className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] sm:hidden">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: MODE_META[currentMode].tone }} />
                {`Signup ${MODE_META[currentMode].label.toLowerCase()}`}
                {status && <span className="text-[var(--text-muted)]">{`· ${PRODUCT_STATUSES.find((s) => s.value === status.productStatus)?.label ?? status.productStatus}`}</span>}
              </p>
            )}

            {/* ── Toolbar: status tabs · search · sort ─────────────────────── */}
            <div className="flex flex-wrap items-center gap-2" data-beta-toolbar>
              <span role="tablist" aria-label="Request status" className="inline-flex items-center rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5">
                {([["pending", "Waiting", reqs.counts.pending], ["invited", "Invited", reqs.counts.approved]] as const).map(([id, label, count]) => (
                  <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => { setTab(id); setShowAll(false); setSort(id === "pending" ? "oldest" : "newest"); }}
                    className={`min-h-11 rounded-[var(--radius-xs)] px-2.5 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-7 ${
                      tab === id ? "bg-[var(--surface-raised,rgba(255,255,255,.06))] text-[var(--text-primary)]" : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"}`}>
                    {label} <span className="text-[var(--text-muted)]">{count}</span>
                  </button>
                ))}
              </span>
              <label className="order-last flex min-h-11 min-w-0 basis-full items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 sm:order-none sm:max-w-xs sm:flex-1 sm:basis-auto lg:min-h-8">
                <Search size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tab === "pending" ? "Search email or source" : "Search email"}
                  aria-label="Search beta signups" className="min-w-0 flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)] focus:outline-none" />
              </label>
              <button type="button" onClick={() => setSort((s) => (s === "newest" ? "oldest" : "newest"))} aria-label={`Sort: ${sort} first`}
                className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:min-h-8">
                <ArrowUpDown size={12} aria-hidden /> {sort === "newest" ? "Newest" : "Oldest"}
              </button>
            </div>

            {/* ── The list: compact table ≥ lg, two-line rows below ────────── */}
            {tab === "pending" ? (
              pendingRows.length === 0 ? (
                <p className="py-4 text-xs text-[var(--text-secondary)]">{q ? "No waiting request matches." : "No pending requests."}</p>
              ) : (
                <>
                  <table className="w-full table-fixed text-xs max-lg:hidden" aria-label="Waiting beta requests">
                    <thead className="border-b border-[var(--border-hairline)]">
                      <tr><th className={`${TH} w-[34%]`}>Email</th><th className={TH}>Requested</th><th className={TH}>Submissions</th><th className={`${TH} w-[30%]`}>Source</th><th className={`${TH} w-8`}><span className="sr-only">Open</span></th></tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-hairline)]">
                      {pendingRows.slice(0, limit).map((r) => (
                        <tr key={r.id} onClick={() => openRequest(r.id)} className="cursor-pointer transition-colors hover:bg-[var(--surface-hover)]">
                          <td className={`${TD} truncate font-medium text-[var(--text-primary)]`}>
                            <button type="button" onClick={(e) => { e.stopPropagation(); openRequest(r.id); }} aria-haspopup="dialog" className="max-w-full truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">{r.email}</button>
                          </td>
                          <td className={`${TD} tabular-nums text-[var(--text-secondary)]`}>{`${timeAgo(r.createdAt)} ago`}</td>
                          <td className={`${TD} tabular-nums text-[var(--text-secondary)]`}>{r.requestCount > 1 ? `${r.requestCount}×` : "1"}</td>
                          <td className={`${TD} truncate text-[var(--text-muted)]`}>{describeAcquisitionSource(r.acquisition) ?? "—"}</td>
                          <td className={`${TD} text-[var(--text-faint)]`}><ChevronRight size={12} aria-hidden /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <ul className="-mx-1 divide-y divide-[var(--border-hairline)] lg:hidden" aria-label="Waiting beta requests">
                    {pendingRows.slice(0, limit).map((r) => (
                      <li key={r.id}>
                        <button type="button" onClick={() => openRequest(r.id)} aria-haspopup="dialog"
                          className="flex min-h-11 w-full items-center justify-between gap-2 px-1 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]">
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{r.email}</span>
                            <span className="block truncate text-[10px] text-[var(--text-muted)]">
                              {`${timeAgo(r.createdAt)} ago`}{r.requestCount > 1 ? ` · ${r.requestCount}×` : ""}{describeAcquisitionSource(r.acquisition) ? ` · ${describeAcquisitionSource(r.acquisition)}` : ""}
                            </span>
                          </span>
                          <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : invitationRows.length === 0 ? (
              <p className="py-4 text-xs text-[var(--text-secondary)]">{q ? "No invitation matches." : "No open invitations."}</p>
            ) : (
              <>
                <table className="w-full table-fixed text-xs max-lg:hidden" aria-label="Open beta invitations">
                  <thead className="border-b border-[var(--border-hairline)]">
                    <tr><th className={`${TH} w-[34%]`}>Email</th><th className={TH}>Invited</th><th className={TH}>Expires</th><th className={`${TH} w-[30%]`}>Invite email</th><th className={`${TH} w-8`}><span className="sr-only">Open</span></th></tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {invitationRows.slice(0, limit).map((inv) => (
                      <tr key={inv.id} onClick={() => openInvitation(inv.id)} className="cursor-pointer transition-colors hover:bg-[var(--surface-hover)]">
                        <td className={`${TD} truncate font-medium text-[var(--text-primary)]`}>
                          <button type="button" onClick={(e) => { e.stopPropagation(); openInvitation(inv.id); }} aria-haspopup="dialog" className="max-w-full truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)]">{inv.email}</button>
                        </td>
                        <td className={`${TD} tabular-nums text-[var(--text-secondary)]`}>{inv.invitedAt ? `${timeAgo(inv.invitedAt)} ago` : "—"}</td>
                        <td className={`${TD} tabular-nums`} style={{ color: inv.expired ? "var(--accent-warning)" : "var(--text-secondary)" }}>
                          {inv.inviteExpiresAt ? (inv.expired ? "Expired" : until(inv.inviteExpiresAt)) : "—"}
                        </td>
                        <td className={`${TD} truncate text-[var(--text-muted)]`}>{inviteEmailLabel(inv.inviteEmail)}</td>
                        <td className={`${TD} text-[var(--text-faint)]`}><ChevronRight size={12} aria-hidden /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="-mx-1 divide-y divide-[var(--border-hairline)] lg:hidden" aria-label="Open beta invitations">
                  {invitationRows.slice(0, limit).map((inv) => (
                    <li key={inv.id}>
                      <button type="button" onClick={() => openInvitation(inv.id)} aria-haspopup="dialog"
                        className="flex min-h-11 w-full items-center justify-between gap-2 px-1 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]">
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{inv.email}</span>
                          <span className="block truncate text-[10px] text-[var(--text-muted)]">
                            {inv.invitedAt ? `invited ${timeAgo(inv.invitedAt)} ago` : "invited"}{` · email ${inviteEmailLabel(inv.inviteEmail)}`}
                          </span>
                        </span>
                        <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: inv.expired ? "var(--accent-warning)" : "var(--text-muted)" }}>
                          {inv.expired ? "Expired" : "Open"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* ── Footer: show all · the decided counts (not rows) ─────────── */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-2 text-[11px] text-[var(--text-muted)] tabular-nums">
              <span className="flex flex-wrap items-center gap-x-2">
                <span>{`${reqs.counts.redeemed} joined · ${reqs.counts.denied} declined or revoked`}</span>
                {truncated && <span data-list-truncated>{truncated}</span>}
                <LoadedStamp checkedAt={loadedAt} />
              </span>
              {rowsShown > LIST_ROWS && (
                <button type="button" onClick={() => setShowAll((v) => !v)} className="inline-flex min-h-11 items-center text-[var(--text-secondary)] hover:text-[var(--text-primary)] lg:min-h-8">
                  {showAll ? "Show fewer" : `Show all ${rowsShown}`}
                </button>
              )}
            </div>

          {/* ── Pending-request detail panel ─────────────────────────────── */}
          <RightPanel open={selectedRequest != null} onClose={() => setSelectedRequestId(null)} ariaLabel="Beta request detail">
            {selectedRequest && (
              <>
                <PanelHeader eyebrow="Beta request" title={selectedRequest.email} />
                <PanelContent>
                  <div className="flex flex-col gap-3 text-xs">
                    {error && <ActionError message={error} />}
                    <Row label="Requested" value={`${timeAgo(selectedRequest.createdAt)} ago`} />
                    {selectedRequest.requestCount > 1 && (
                      <Row label="Submissions" value={`${selectedRequest.requestCount}× · last ${selectedRequest.lastRequestedAt ? `${timeAgo(selectedRequest.lastRequestedAt)} ago` : "—"}`} />
                    )}
                    {describeAcquisitionSource(selectedRequest.acquisition) && (
                      <Row label="Source" value={describeAcquisitionSource(selectedRequest.acquisition) as string} />
                    )}
                    <Row label="Status" value="Pending" />
                    {selectedRequest.note && (
                      <div className="flex flex-col gap-1 border-t border-[var(--border-hairline)] pt-3">
                        <span className="text-[var(--text-secondary)]">Note</span>
                        <span className="leading-snug text-[var(--text-primary)]">{selectedRequest.note}</span>
                      </div>
                    )}
                    <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                      Approve mints a single-use, email-bound invite (14-day expiry) and emails it. Redemption requires
                      registration mode = invite-only.
                    </p>
                    {!canWrite && <p className="text-[11px] leading-snug text-[var(--text-muted)]" data-read-only-line>{GROWTH_READ_ONLY_LINE}</p>}
                  </div>
                </PanelContent>
                {canWrite && (
                <PanelFooter>
                  <button onClick={() => decide(selectedRequest.id, "deny")} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}>
                    <X size={13} aria-hidden /> Deny
                  </button>
                  <button onClick={() => decide(selectedRequest.id, "approve")} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                    {acting === selectedRequest.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} aria-hidden />} Approve &amp; invite
                  </button>
                </PanelFooter>
                )}
              </>
            )}
          </RightPanel>

          {/* ── Invitation detail panel ──────────────────────────────────── */}
          <RightPanel open={selectedInvitation != null} onClose={() => setSelectedInvitationId(null)} ariaLabel="Invitation detail">
            {selectedInvitation && (
              <>
                <PanelHeader eyebrow="Invitation" title={selectedInvitation.email} />
                <PanelContent>
                  <div className="flex flex-col gap-3 text-xs">
                    {error && <ActionError message={error} />}
                    <Row label="Invited" value={selectedInvitation.invitedAt ? `${timeAgo(selectedInvitation.invitedAt)} ago` : "—"} />
                    <Row label="Expires" value={selectedInvitation.inviteExpiresAt
                      ? (selectedInvitation.expired ? `expired ${timeAgo(selectedInvitation.inviteExpiresAt)} ago` : until(selectedInvitation.inviteExpiresAt))
                      : "—"} />
                    <Row label="Status" value={selectedInvitation.expired ? "Expired" : "Pending"} />
                    <Row label="Invite email" value={inviteEmailLabel(selectedInvitation.inviteEmail)} />
                    <p className="text-[11px] leading-snug text-[var(--text-muted)]">
                      Email status is the provider hand-off recorded at send time — Fourth Meridian holds no delivery
                      receipt, so &ldquo;handed to provider&rdquo; is not &ldquo;delivered&rdquo;.
                    </p>
                    <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                      Resend rotates the single-use token and re-emails it (email-binding + expiry preserved). Revoke kills
                      the invitation only — it never removes users or existing access.
                    </p>
                    {!canWrite && <p className="text-[11px] leading-snug text-[var(--text-muted)]" data-read-only-line>{GROWTH_READ_ONLY_LINE}</p>}
                  </div>
                </PanelContent>
                {canWrite && (
                <PanelFooter>
                  <button onClick={() => { setError(null); setRevokeId(selectedInvitation.id); }} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}>
                    <Ban size={13} aria-hidden /> Revoke
                  </button>
                  <button onClick={() => resend(selectedInvitation.id)} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                    {acting === selectedInvitation.id ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Send size={13} aria-hidden />} Resend
                  </button>
                </PanelFooter>
                )}
              </>
            )}
          </RightPanel>

          {/* ── Confirmations ────────────────────────────────────────────── */}
          {canWrite && pendingMode && (
            <ConfirmDialog
              icon={ShieldAlert}
              title={`Change signup mode to ${MODE_META[pendingMode].label}?`}
              message={<>{MODE_META[pendingMode].detail}{error && <ActionError message={error} />}<OperatorReasonField value={reason} onChange={setReason} disabled={acting === "mode"} /></>}
              confirmLabel="Change mode"
              confirmTone={pendingMode === "open" ? "danger" : "meridian"}
              busy={acting === "mode"}
              confirmDisabled={reasonPayload(reason) === null}
              onConfirm={() => changeMode(pendingMode)}
              onClose={closeConfirm(() => setPendingMode(null))}
            />
          )}
          {canWrite && pendingStatus && (
            <ConfirmDialog
              icon={Rocket}
              title={`Set product status to ${PRODUCT_STATUSES.find((s) => s.value === pendingStatus)?.label}?`}
              message={<>This is framing only — it does not change who can sign up (that&apos;s the beta mode).{error && <ActionError message={error} />}<OperatorReasonField value={reason} onChange={setReason} disabled={acting === "status"} /></>}
              confirmLabel="Update status"
              confirmTone="meridian"
              busy={acting === "status"}
              confirmDisabled={reasonPayload(reason) === null}
              onConfirm={() => changeStatus(pendingStatus)}
              onClose={closeConfirm(() => setPendingStatus(null))}
            />
          )}
          {canWrite && revokeId && (
            <ConfirmDialog
              icon={Ban}
              title="Revoke this invitation?"
              message={<>The single-use token will be invalidated and can no longer be redeemed. No users or existing access are removed.{error && <ActionError message={error} />}<OperatorReasonField value={reason} onChange={setReason} disabled={acting === revokeId} /></>}
              confirmLabel="Revoke invitation"
              busy={acting === revokeId}
              confirmDisabled={reasonPayload(reason) === null}
              onConfirm={() => revoke(revokeId)}
              onClose={closeConfirm(() => setRevokeId(null))}
            />
          )}
          </>
        )}
      </Surface>
    </Block>
  );
}

/** One labelled key/value row in a detail panel. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[var(--text-secondary)]">{label}</span>
      <span className="text-[var(--text-primary)]">{value}</span>
    </div>
  );
}

/** A failed action, shown WHERE the operator is looking (inside the open panel or confirm), never only behind it. */
function ActionError({ message }: { message: string }) {
  return <p role="alert" className="my-2 text-[11px] text-[var(--accent-negative)]" data-action-error>{message}</p>;
}

/** UI-009 — when the list was last read, in UTC (every refetch moves it). */
function LoadedStamp({ checkedAt }: { checkedAt: string | null }) {
  return <UtcStamp iso={checkedAt} label="Read" />;
}
