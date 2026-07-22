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
 */

import { useCallback, useEffect, useState } from "react";
import { Mail, Check, X, Send, Ban, Loader2, ShieldAlert, UserPlus, Rocket } from "lucide-react";
import {
  PlatformWidgetCard,
  WidgetMessage,
  WidgetStat,
  timeAgo,
  type PlatformSection,
} from "../widget-kit";
import { RightPanel, PanelHeader, PanelContent, PanelFooter } from "@/components/atlas/panels";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import type {
  BetaRequestsResponse,
  BetaRequestRow,
  BetaInvitationRow,
} from "@/app/api/platform/growth-revenue/requests/route";
import type { BetaStatusResponse } from "@/app/api/platform/growth-revenue/beta-status/route";

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

export function GrowthBetaRequestsWidget({ section }: { section: PlatformSection }) {
  const [reqs, setReqs]     = useState<BetaRequestsResponse | null>(null);
  const [status, setStatus] = useState<BetaStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [acting, setActing]   = useState<string | null>(null); // id or "mode" while a mutation runs

  const [selectedRequestId, setSelectedRequestId]       = useState<string | null>(null);
  const [selectedInvitationId, setSelectedInvitationId] = useState<string | null>(null);
  const [pendingMode, setPendingMode]                   = useState<Mode | null>(null); // mode-change confirm
  const [pendingStatus, setPendingStatus]               = useState<ProductStatus | null>(null); // product-status confirm
  const [revokeId, setRevokeId]                         = useState<string | null>(null); // revoke confirm
  const [inviteOpen, setInviteOpen]                     = useState(false); // direct-invite form
  const [inviteEmail, setInviteEmail]                   = useState("");
  const [inviteDays, setInviteDays]                     = useState("7");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rReq, rStatus] = await Promise.all([
        fetch("/api/platform/growth-revenue/requests", { credentials: "same-origin" }),
        fetch("/api/platform/growth-revenue/beta-status", { credentials: "same-origin" }),
      ]);
      if (!rReq.ok) throw new Error(rReq.status === 403 ? "Not authorized" : `Request failed (${rReq.status})`);
      setReqs((await rReq.json()) as BetaRequestsResponse);
      if (rStatus.ok) setStatus((await rStatus.json()) as BetaStatusResponse);
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
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) },
      () => setPendingMode(null));

  const changeStatus = (status: ProductStatus) =>
    run("status", "/api/platform/growth-revenue/product-status",
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) },
      () => setPendingStatus(null));

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
    run(id, `/api/platform/growth-revenue/requests/${id}/revoke`, { method: "POST" },
      () => { setRevokeId(null); setSelectedInvitationId(null); });

  const selectedRequest: BetaRequestRow | null =
    selectedRequestId ? reqs?.pending.find((r) => r.id === selectedRequestId) ?? null : null;
  const selectedInvitation: BetaInvitationRow | null =
    selectedInvitationId ? reqs?.invitations.find((r) => r.id === selectedInvitationId) ?? null : null;

  const currentMode = status?.registrationMode;

  return (
    <PlatformWidgetCard label={section.label} icon={Mail}>
      {loading || error || !reqs ? (
        <WidgetMessage loading={loading} error={error} />
      ) : (
        <>
          {/* ── Platform status (launch axis — separate from signup gate) ─── */}
          {status && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2">
                <Rocket size={13} className="text-[var(--text-muted)]" aria-hidden />
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Platform status</span>
              </span>
              <div className="inline-flex rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5" role="group" aria-label="Product status">
                {PRODUCT_STATUSES.map((s) => {
                  const active = s.value === status.productStatus;
                  return (
                    <button key={s.value} type="button" disabled={acting !== null}
                      onClick={() => { if (!active) setPendingStatus(s.value); }}
                      aria-pressed={active}
                      className="rounded-[calc(var(--radius-sm)-2px)] px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                      style={active ? { background: "var(--surface-inset)", color: "var(--text-primary)" } : { color: "var(--text-secondary)" }}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Beta mode control ─────────────────────────────────────────── */}
          {currentMode && (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: MODE_META[currentMode].tone }} aria-hidden />
                <span className="text-sm font-medium text-[var(--text-primary)]">Beta access · {MODE_META[currentMode].label}</span>
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">{MODE_META[currentMode].detail}</span>
              <div className="mt-1 inline-flex rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-0.5" role="group" aria-label="Signup mode">
                {MODES.map((m) => {
                  const active = m.value === currentMode;
                  return (
                    <button
                      key={m.value}
                      type="button"
                      disabled={acting !== null}
                      onClick={() => { if (!active) setPendingMode(m.value); }}
                      aria-pressed={active}
                      className="rounded-[calc(var(--radius-sm)-2px)] px-3 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                      style={active
                        ? { background: "var(--surface-inset)", color: "var(--text-primary)" }
                        : { color: "var(--text-secondary)" }}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Funnel figures ────────────────────────────────────────────── */}
          <div className="grid grid-cols-4 gap-2 border-t border-[var(--border-hairline)] pt-3">
            <WidgetStat value={reqs.counts.pending} label="Pending" />
            <WidgetStat value={reqs.counts.approved} label="Approved" />
            <WidgetStat value={reqs.counts.redeemed} label="Activated" />
            <WidgetStat value={reqs.counts.denied} label="Declined" />
          </div>
          {status && (
            <div className="grid grid-cols-4 gap-2">
              <WidgetStat value={status.invitations.sent} label="Sent" />
              <WidgetStat value={status.invitations.accepted} label="Accepted" />
              <WidgetStat value={status.invitations.expired} label="Expired" />
              <WidgetStat value={status.invitations.revoked} label="Revoked" />
            </div>
          )}

          {/* ── Direct operator invite ───────────────────────────────────── */}
          <div className="flex flex-col gap-2 border-t border-[var(--border-hairline)] pt-3">
            {!inviteOpen ? (
              <button type="button" onClick={() => setInviteOpen(true)} disabled={acting !== null}
                className="inline-flex w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                <UserPlus size={13} /> Invite user
              </button>
            ) : (
              <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border p-2.5" style={{ borderColor: "var(--border-hairline)", background: "var(--surface-inset)" }}>
                <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Invite a user directly</p>
                <input
                  type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="email@example.com" autoComplete="off"
                  className="rounded-[var(--radius-sm)] border bg-transparent px-2.5 py-1.5 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-faint)]"
                  style={{ borderColor: "var(--border-hairline)" }}
                />
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-[var(--text-secondary)]">Expires in</label>
                  <input
                    type="number" min={1} max={30} value={inviteDays} onChange={(e) => setInviteDays(e.target.value)}
                    className="w-16 rounded-[var(--radius-sm)] border bg-transparent px-2 py-1 text-xs tabular-nums text-[var(--text-primary)]"
                    style={{ borderColor: "var(--border-hairline)" }}
                  />
                  <span className="text-[11px] text-[var(--text-muted)]">days</span>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => { setInviteOpen(false); setInviteEmail(""); }} disabled={acting !== null}
                    className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}>
                    Cancel
                  </button>
                  <button type="button" onClick={sendInvite} disabled={acting !== null || !inviteEmail.trim()}
                    className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                    {acting === "invite" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send invite
                  </button>
                </div>
                <p className="text-[10px] leading-snug text-[var(--text-muted)]">
                  Creates an email-bound, single-use invitation and emails it. No transferable link.
                </p>
              </div>
            )}
          </div>

          {/* ── Pending queue → Approve / Deny ────────────────────────────── */}
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Pending requests</p>
            {reqs.pending.length === 0 ? (
              <p className="text-xs text-[var(--text-secondary)]">No pending requests.</p>
            ) : (
              <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
                {reqs.pending.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRequestId(r.id)}
                      className="group relative flex w-full items-center justify-between gap-2 overflow-hidden px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
                    >
                      <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{r.email}</span>
                        <span className="block text-[10px] text-[var(--text-muted)]">{timeAgo(r.createdAt)} ago</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── Approved invitations → Resend / Revoke ───────────────────── */}
          {reqs.invitations.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Invitations</p>
              <ul className="-mx-1 divide-y divide-[var(--border-hairline)]">
                {reqs.invitations.map((inv) => (
                  <li key={inv.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedInvitationId(inv.id)}
                      className="group relative flex w-full items-center justify-between gap-2 overflow-hidden px-1 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--meridian-400)]"
                    >
                      <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--meridian-400)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium text-[var(--text-primary)]">{inv.email}</span>
                        <span className="block text-[10px] text-[var(--text-muted)]">
                          {inv.invitedAt ? `invited ${timeAgo(inv.invitedAt)} ago` : "invited"}
                        </span>
                      </span>
                      <span
                        className="shrink-0 text-[10px] uppercase tracking-wide"
                        style={{ color: inv.expired ? "var(--accent-warning)" : "var(--text-muted)" }}
                      >
                        {inv.expired ? "Expired" : "Pending"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ── Pending-request detail panel ─────────────────────────────── */}
          <RightPanel open={selectedRequest != null} onClose={() => setSelectedRequestId(null)} ariaLabel="Beta request detail">
            {selectedRequest && (
              <>
                <PanelHeader eyebrow="Beta request" title={selectedRequest.email} />
                <PanelContent>
                  <div className="flex flex-col gap-3 text-xs">
                    <Row label="Requested" value={`${timeAgo(selectedRequest.createdAt)} ago`} />
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
                  </div>
                </PanelContent>
                <PanelFooter>
                  <button onClick={() => decide(selectedRequest.id, "deny")} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}>
                    <X size={13} /> Deny
                  </button>
                  <button onClick={() => decide(selectedRequest.id, "approve")} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(52,211,153,.12)", color: "var(--success-400, #34d399)", borderColor: "rgba(52,211,153,.3)" }}>
                    {acting === selectedRequest.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Approve &amp; invite
                  </button>
                </PanelFooter>
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
                    <Row label="Invited" value={selectedInvitation.invitedAt ? `${timeAgo(selectedInvitation.invitedAt)} ago` : "—"} />
                    <Row label="Expires" value={selectedInvitation.inviteExpiresAt
                      ? (selectedInvitation.expired ? `expired ${timeAgo(selectedInvitation.inviteExpiresAt)} ago` : until(selectedInvitation.inviteExpiresAt))
                      : "—"} />
                    <Row label="Status" value={selectedInvitation.expired ? "Expired" : "Pending"} />
                    <p className="border-t border-[var(--border-hairline)] pt-3 text-[11px] leading-snug text-[var(--text-muted)]">
                      Resend rotates the single-use token and re-emails it (email-binding + expiry preserved). Revoke kills
                      the invitation only — it never removes users or existing access.
                    </p>
                  </div>
                </PanelContent>
                <PanelFooter>
                  <button onClick={() => setRevokeId(selectedInvitation.id)} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "rgba(248,113,113,.1)", color: "var(--danger-400, #f87171)", borderColor: "rgba(248,113,113,.28)" }}>
                    <Ban size={13} /> Revoke
                  </button>
                  <button onClick={() => resend(selectedInvitation.id)} disabled={acting !== null}
                    className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
                    style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                    {acting === selectedInvitation.id ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Resend
                  </button>
                </PanelFooter>
              </>
            )}
          </RightPanel>

          {/* ── Confirmations ────────────────────────────────────────────── */}
          {pendingMode && (
            <ConfirmDialog
              icon={ShieldAlert}
              title={`Change signup mode to ${MODE_META[pendingMode].label}?`}
              message={MODE_META[pendingMode].detail}
              confirmLabel="Change mode"
              confirmTone={pendingMode === "open" ? "danger" : "meridian"}
              busy={acting === "mode"}
              onConfirm={() => changeMode(pendingMode)}
              onClose={() => setPendingMode(null)}
            />
          )}
          {pendingStatus && (
            <ConfirmDialog
              icon={Rocket}
              title={`Set product status to ${PRODUCT_STATUSES.find((s) => s.value === pendingStatus)?.label}?`}
              message="This is framing only — it does not change who can sign up (that's the beta mode)."
              confirmLabel="Update status"
              confirmTone="meridian"
              busy={acting === "status"}
              onConfirm={() => changeStatus(pendingStatus)}
              onClose={() => setPendingStatus(null)}
            />
          )}
          {revokeId && (
            <ConfirmDialog
              icon={Ban}
              title="Revoke this invitation?"
              message="The single-use token will be invalidated and can no longer be redeemed. No users or existing access are removed."
              confirmLabel="Revoke invitation"
              busy={acting === revokeId}
              onConfirm={() => revoke(revokeId)}
              onClose={() => setRevokeId(null)}
            />
          )}
        </>
      )}
    </PlatformWidgetCard>
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
