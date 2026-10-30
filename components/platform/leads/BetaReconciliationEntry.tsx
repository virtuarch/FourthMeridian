"use client";

/**
 * components/platform/leads/BetaReconciliationEntry.tsx  (owner ruling, 2026-10-30)
 *
 * The ONE deliberate entry on the Policies hero that gives every ACTIVE
 * customer with NO policy assignment the beta default:
 *
 *   "Assign Beta to n unassigned accounts"  →  ConfirmDialog
 *      the exact count · the guarantee · a REQUIRED structured reason
 *   → POST /api/platform/platform-ops/policies/reconcile-beta { reason, expectedEligible: n }
 *   → re-reads the Policies catalogue, Attention and the dry run into the shared session.
 *
 * GATING. Offered only when the operator's resolved access carries `canControl`
 * (descriptive — the server's fresh check is the authority) AND the dry run
 * reports eligible > 0. Otherwise it renders NOTHING: no disabled button, no
 * placeholder. The dry-run read itself mounts only behind the flag, so an
 * operator who could never press it never asks.
 *
 * The count the operator confirms is sent back as `expectedEligible`; if the
 * population moved, the server answers 409 and writes nothing, and the entry
 * re-reads the dry run so the next confirmation shows the new count.
 */

import { useCallback, useState } from "react";
import { UserPlus } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import type { SpaceMountAccess } from "@/lib/space/mount-context";
import type {
  BetaReconciliationApplyResponse, BetaReconciliationDryRunResponse, BetaReconciliationRefusal,
} from "@/app/api/platform/platform-ops/policies/reconcile-beta/route";
import type { PolicyGroupsResponse } from "@/app/api/platform/platform-ops/policy-groups/route";
import type { AttentionResponse } from "@/lib/platform/ops/attention";
import { useSharedWidgetFetch, useSharedWidgetPublish } from "../workspace-session";
import { TONE_COLOR, type StatusTone } from "../platform-surface";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import { RECONCILE_GUARANTEE, reconcileConfirmCount, reconcileEntryLabel, reconcileOutcome } from "./policies-model";

export const RECONCILE_URL = "/api/platform/platform-ops/policies/reconcile-beta";
const POLICY_GROUPS_URL = "/api/platform/platform-ops/policy-groups";
const ATTENTION_URL = "/api/platform/platform-ops/attention";

const ENTRY = "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--border-hairline)] px-3 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-inset)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8";

/** PURE presentation of the entry (prop-driven; every state renders in a test). */
export function BetaReconciliationButton({ eligible, onSelect }: { eligible: number | null | undefined; onSelect: () => void }) {
  const label = reconcileEntryLabel(eligible);
  if (!label) return null;
  return (
    <button type="button" onClick={onSelect} aria-haspopup="dialog" data-beta-reconcile className={ENTRY}>
      <UserPlus size={13} aria-hidden /> {label}
    </button>
  );
}

/** The confirmation body: the exact count, the guarantee, the reason (exported for the render test). */
export function BetaReconciliationConfirmBody({ eligible, reason, onReason, disabled }: {
  eligible: number; reason: OperatorReasonValue; onReason: (v: OperatorReasonValue) => void; disabled: boolean;
}) {
  return (
    <>
      <span className="block" data-reconcile-count>{reconcileConfirmCount(eligible)}</span>
      <span className="mt-2 block text-xs" data-reconcile-guarantee>{RECONCILE_GUARANTEE}</span>
      <OperatorReasonField value={reason} onChange={onReason} disabled={disabled} />
    </>
  );
}

function Reconcile() {
  const dryRun = useSharedWidgetFetch<BetaReconciliationDryRunResponse>("/api/platform/platform-ops/policies/reconcile-beta");
  const publishDryRun = useSharedWidgetPublish<BetaReconciliationDryRunResponse>(RECONCILE_URL);
  const publishGroups = useSharedWidgetPublish<PolicyGroupsResponse>(POLICY_GROUPS_URL);
  const publishAttention = useSharedWidgetPublish<AttentionResponse>(ATTENTION_URL);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [reason, setReason] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; tone: StatusTone } | null>(null);

  const refresh = useCallback(async () => {
    const read = async <T,>(url: string, publish: (d: T) => void) => {
      try { const r = await fetch(url, { credentials: "same-origin" }); if (r.ok) publish((await r.json()) as T); } catch { /* the previous answer stays */ }
    };
    await Promise.all([read(POLICY_GROUPS_URL, publishGroups), read(ATTENTION_URL, publishAttention), read(RECONCILE_URL, publishDryRun)]);
  }, [publishGroups, publishAttention, publishDryRun]);

  const apply = useCallback(async (expectedEligible: number) => {
    const why = reasonPayload(reason);
    if (!why) return;
    setBusy(true);
    setFeedback(null);
    try {
      const r = await fetch(RECONCILE_URL, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: why, expectedEligible }),
      });
      const body = (await r.json().catch(() => ({}))) as Partial<BetaReconciliationApplyResponse> & BetaReconciliationRefusal;
      setFeedback(reconcileOutcome(r.status, body));
      if (body.dryRun) publishDryRun(body.dryRun);
      await refresh();
    } catch (e) {
      setFeedback({ text: e instanceof Error ? e.message : "Not applied", tone: "bad" });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }, [reason, refresh, publishDryRun]);

  return (
    <>
      {feedback && <span role="status" className="text-[11px]" style={{ color: TONE_COLOR[feedback.tone] }}>{feedback.text}</span>}
      <BetaReconciliationButton eligible={dryRun.data?.eligible}
        onSelect={() => { setReason(EMPTY_OPERATOR_REASON); setFeedback(null); setConfirming(dryRun.data?.eligible ?? null); }} />
      {confirming !== null && (
        <ConfirmDialog
          open
          icon={UserPlus}
          title={reconcileEntryLabel(confirming) ?? "Assign Beta"}
          message={<BetaReconciliationConfirmBody eligible={confirming} reason={reason} onReason={setReason} disabled={busy} />}
          confirmLabel="Assign Beta"
          confirmTone="meridian"
          confirmDisabled={reasonPayload(reason) === null}
          busy={busy}
          onClose={() => { if (!busy) setConfirming(null); }}
          onConfirm={() => { void apply(confirming); }}
        />
      )}
    </>
  );
}

/** Mounted on the Policies hero. Renders nothing unless the operator may act. */
export function BetaReconciliationEntry({ access }: { access?: SpaceMountAccess }) {
  return access?.canControl === true ? <Reconcile /> : null;
}
