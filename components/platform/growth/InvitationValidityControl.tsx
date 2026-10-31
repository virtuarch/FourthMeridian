"use client";

/**
 * components/platform/growth/InvitationValidityControl.tsx  (PR B)
 *
 * The configured beta-invitation validity, inside Growth's Access settings.
 *
 *   READ holder   plain text — "Invitations valid 7 days" — and what it governs.
 *   WRITE holder  + a whole-day input (bounds shown), a required structured
 *                 reason and Save. The PUT carries the `version` it loaded; a
 *                 409 (someone else saved first) shows the CURRENT value and
 *                 asks the operator to review before saving again — nothing is
 *                 retried silently.
 *
 * The read is the workspace-shared GET /invitation-policy (useSharedWidgetFetch),
 * so the beta widget's direct-invite form reads the same answer; a save
 * publishes the route's returned model to every reader of that URL.
 *
 * UI-001 — the editable control renders only inside a `canWrite` region; the
 * server gate (fresh GROWTH_REVENUE WRITE) decides regardless.
 */

import { useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { useSharedWidgetFetch, useSharedWidgetPublish } from "../workspace-session";
import { EMPTY_OPERATOR_REASON, OperatorReasonField, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import type { InvitationPolicyReadModel } from "@/lib/platform/growth/invitation-issue.core";

export const INVITATION_POLICY_URL = "/api/platform/growth-revenue/invitation-policy";

/** The configured validity — shared with every reader in the workspace session. */
export function useInvitationPolicy() {
  return useSharedWidgetFetch<InvitationPolicyReadModel>(INVITATION_POLICY_URL);
}

export const daysLabel = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function InvitationValidityControl({ canWrite }: { canWrite: boolean }) {
  const { data, loading, error } = useInvitationPolicy();
  const publish = useSharedWidgetPublish<InvitationPolicyReadModel>(INVITATION_POLICY_URL);
  const [draft, setDraft] = useState<string | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  const value = draft ?? (data ? String(data.validityDays) : "");
  const n = Number(value);
  const inBounds = !!data && /^\d+$/.test(value.trim()) && n >= data.min && n <= data.max;
  const changed = !!data && inBounds && n !== data.validityDays;

  async function save() {
    if (!data || !changed) return;
    const r = reasonPayload(reason);
    if (!r) return;
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch(INVITATION_POLICY_URL, {
        method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ validityDays: n, version: data.version, reason: r }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<InvitationPolicyReadModel> & { error?: string; model?: InvitationPolicyReadModel };
      if (res.ok) {
        publish(body as InvitationPolicyReadModel);
        setDraft(null);
        setReason(EMPTY_OPERATOR_REASON);
        setNote({ tone: "ok", text: `Saved. New invitations are valid ${daysLabel(n)}.` });
      } else if (res.status === 409 && body.model) {
        publish(body.model);
        setNote({ tone: "warn", text: `Someone changed this since you loaded it — it is now ${daysLabel(body.model.validityDays)}. Review, then save again.` });
      } else {
        setNote({ tone: "error", text: body.error ?? `Save failed (${res.status})` });
      }
    } catch {
      setNote({ tone: "error", text: "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2" data-invitation-validity>
      <span className="flex items-center gap-2">
        <CalendarClock size={13} className="text-[var(--text-muted)]" aria-hidden />
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-muted)]">Invitation validity</span>
      </span>
      <span className="text-sm font-medium text-[var(--text-primary)]" data-invitation-validity-value>
        {data ? `Invitations valid ${daysLabel(data.validityDays)}` : loading ? "Loading…" : (error ?? "Unavailable")}
      </span>
      <span className="text-[11px] leading-snug text-[var(--text-muted)]">
        Applies to new invitations — approve, direct invite and resend. Invitations already sent keep their expiry; use Extend on one to change it.
      </span>

      {canWrite && data && (
        <div className="flex flex-col gap-2" data-invitation-validity-editor>
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="growth-invitation-validity" className="text-[11px] text-[var(--text-secondary)]">Valid for</label>
            <input
              id="growth-invitation-validity"
              type="number" inputMode="numeric" min={data.min} max={data.max} step={1} value={value} disabled={saving}
              onChange={(e) => { setDraft(e.target.value); setNote(null); }}
              aria-describedby="growth-invitation-validity-bounds"
              className="min-h-11 w-16 rounded-[var(--radius-sm)] border bg-transparent px-2 text-base tabular-nums text-[var(--text-primary)] sm:text-xs lg:min-h-8"
              style={{ borderColor: "var(--border-hairline)" }}
            />
            <span className="text-[11px] text-[var(--text-muted)]">days</span>
            <span id="growth-invitation-validity-bounds" className="text-[11px] text-[var(--text-muted)] tabular-nums">
              {`${data.min}–${data.max} · default ${data.default}`}
            </span>
          </div>
          {changed && (
            <>
              <OperatorReasonField value={reason} onChange={setReason} disabled={saving} />
              <button type="button" onClick={save} disabled={saving || reasonPayload(reason) === null}
                className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-[var(--radius-sm)] border px-3 text-xs font-semibold disabled:opacity-40 lg:min-h-8"
                style={{ background: "var(--surface-inset)", color: "var(--text-primary)", borderColor: "var(--border-hairline)" }}>
                {saving && <Loader2 size={13} className="animate-spin" aria-hidden />} Save
              </button>
            </>
          )}
          {!inBounds && value.trim() !== "" && (
            <p className="text-[11px] text-[var(--accent-warning)]">{`Choose a whole number of days from ${data.min} to ${data.max}.`}</p>
          )}
        </div>
      )}
      {note && (
        <p role={note.tone === "error" ? "alert" : "status"} className="text-[11px]"
          style={{ color: note.tone === "error" ? "var(--accent-negative)" : note.tone === "warn" ? "var(--accent-warning)" : "var(--text-secondary)" }}>
          {note.text}
        </p>
      )}
    </div>
  );
}
