"use client";
/**
 * components/platform/widgets/PlaidWebhookPanel.tsx  (Release 2 — domain split)
 *
 * Repoint existing Plaid Items' webhooks to this deployment's own
 * /api/plaid/webhook — ONE Item at a time, after a dry run the operator reads.
 *
 *   Check     → GET connections/[id]/webhook (reads Plaid, writes nothing)
 *   Repoint   → POST with the target the dry run showed + a structured reason;
 *               two clicks (arm, then confirm). The server re-derives the target
 *               and refuses a mismatch, then reads the Item back to verify.
 *
 * Rendered only for operators holding the top Platform Operations rank (the
 * server is the authority; every route re-checks). The target is shown, never
 * typed. "Last acknowledged" is Plaid's WEBHOOK_UPDATE_ACKNOWLEDGED arriving at
 * the new URL — the delivery proof.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Webhook } from "lucide-react";
import { OPERATOR_REASON_CODES, type OperatorReasonCode } from "@/lib/audit";
import type { PlaidWebhookRosterResponse } from "@/app/api/platform/platform-ops/plaid-webhooks/route";
import type { WebhookMigrationView } from "@/lib/plaid/webhook-migration";
import { BTN, BTN_PRIMARY, BTN_QUIET, FIELD, formatUtc } from "./policy-editor-kit";

export const PLAID_WEBHOOK_PANEL_TITLE = "Plaid webhook routing";

const ACTION_WORDS: Record<string, string> = {
  UPDATE: "Needs repointing",
  ALREADY_CURRENT: "Delivers to this app",
  SKIP_STATUS: "Not repointable (no live token)",
  NO_TARGET: "No public app URL on this deployment",
};

type RowState = {
  checking: boolean;
  view: WebhookMigrationView | null;
  error: string | null;
  reason: OperatorReasonCode | "";
  armed: boolean;
  applying: boolean;
  result: string | null;
};

const EMPTY: RowState = { checking: false, view: null, error: null, reason: "", armed: false, applying: false, result: null };

export function PlaidWebhookPanel() {
  const [roster, setRoster] = useState<PlaidWebhookRosterResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  useEffect(() => {
    let live = true;
    fetch("/api/platform/platform-ops/plaid-webhooks", { credentials: "same-origin" })
      .then(async (r) => { if (!r.ok) throw new Error(`Could not load connections (${r.status}).`); return r.json(); })
      .then((b: PlaidWebhookRosterResponse) => { if (live) setRoster(b); })
      .catch((e: unknown) => { if (live) setLoadError(e instanceof Error ? e.message : "Could not load connections."); });
    return () => { live = false; };
  }, []);

  const patch = useCallback((id: string, p: Partial<RowState>) => {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY), ...p } }));
  }, []);

  async function check(id: string) {
    patch(id, { checking: true, error: null, result: null, armed: false });
    try {
      const r = await fetch(`/api/platform/platform-ops/connections/${id}/webhook`, { credentials: "same-origin" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(b.providerError ? `Plaid refused: ${b.providerError}` : (b.error ?? `Check failed (${r.status})`));
      patch(id, { view: b as WebhookMigrationView });
    } catch (e) {
      patch(id, { error: e instanceof Error ? e.message : "Check failed" });
    } finally {
      patch(id, { checking: false });
    }
  }

  async function apply(id: string) {
    const row = rows[id];
    if (!row?.view?.plan.target || !row.reason) return;
    if (!row.armed) { patch(id, { armed: true }); return; }
    patch(id, { applying: true, error: null });
    try {
      const r = await fetch(`/api/platform/platform-ops/connections/${id}/webhook`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedTarget: row.view.plan.target, reason: { code: row.reason } }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(b.message ?? (b.providerError ? `Plaid refused: ${b.providerError}` : b.error === "NOT_VERIFIED" ? "Plaid did not confirm the new URL. Nothing is reported as done." : `Repoint failed (${r.status})`));
      }
      patch(id, { result: b.outcome === "ALREADY_CURRENT" ? "Already delivering to this app." : `Repointed and verified: ${b.after}` , armed: false });
      await check(id);
    } catch (e) {
      patch(id, { error: e instanceof Error ? e.message : "Repoint failed", armed: false });
    } finally {
      patch(id, { applying: false });
    }
  }

  return (
    <section aria-label={PLAID_WEBHOOK_PANEL_TITLE} className="mt-4 space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        <Webhook size={13} aria-hidden /> {PLAID_WEBHOOK_PANEL_TITLE}
      </h3>
      <p className="text-xs text-[var(--text-muted)]">
        Existing connections keep the webhook URL they were linked with. Check one, then repoint it to this app. Target: {roster?.target ?? "—"}
      </p>
      {loadError && <p role="alert" className="text-xs text-[var(--danger-400,#f87171)]">{loadError}</p>}
      {!roster && !loadError && <p role="status" className="text-xs text-[var(--text-muted)]"><Loader2 size={12} className="inline animate-spin" aria-hidden /> Loading…</p>}
      {roster && roster.items.length === 0 && <p className="text-xs text-[var(--text-muted)]">No repointable Plaid connections.</p>}
      <ul className="space-y-2">
        {roster?.items.map((item) => {
          const row = rows[item.id] ?? EMPTY;
          const v = row.view;
          return (
            <li key={item.id} className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-[var(--text-primary)]">{item.institution} <span className="text-[var(--text-muted)]">· {item.status.toLowerCase()}</span></span>
                <button type="button" className={BTN} style={BTN_QUIET} disabled={row.checking || row.applying} onClick={() => check(item.id)}>
                  {row.checking ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null} Check
                </button>
              </div>
              {v && (
                <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-2 gap-y-0.5 text-[var(--text-secondary)]">
                  <dt>State</dt><dd>{ACTION_WORDS[v.plan.action] ?? v.plan.action}</dd>
                  <dt>Current</dt><dd className="break-all">{v.plan.current ?? "none registered"}</dd>
                  <dt>Target</dt><dd className="break-all">{v.plan.target ?? "—"}</dd>
                  <dt>Last acknowledged</dt><dd>{v.lastAcknowledgedAt ? formatUtc(v.lastAcknowledgedAt) : "never"}</dd>
                </dl>
              )}
              {v?.plan.action === "UPDATE" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select aria-label="Reason" value={row.reason} onChange={(e) => patch(item.id, { reason: e.target.value as OperatorReasonCode | "", armed: false })} disabled={row.applying} className={FIELD} style={{ borderColor: "var(--border-hairline)" }}>
                    <option value="">Reason…</option>
                    {OPERATOR_REASON_CODES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ").toLowerCase()}</option>)}
                  </select>
                  <button type="button" className={BTN} style={BTN_PRIMARY} disabled={!row.reason || row.applying} onClick={() => apply(item.id)}>
                    {row.applying ? <Loader2 size={12} className="animate-spin" aria-hidden /> : null}
                    {row.armed ? "Confirm repoint" : "Repoint webhook"}
                  </button>
                  {row.armed && <span role="alert" className="text-[var(--brass-300)]">Plaid will deliver this connection&apos;s webhooks to the target above.</span>}
                </div>
              )}
              {row.result && <p role="status" className="mt-1 text-[var(--success-400,#34d399)]">{row.result}</p>}
              {row.error && <p role="alert" className="mt-1 text-[var(--danger-400,#f87171)]">{row.error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
