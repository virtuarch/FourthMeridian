"use client";

/**
 * components/platform/incidents/CustomerUpdateSection.tsx  (Incident customer update, PR-C2 — the drawer UI)
 *
 * Owner yes; S2 rulings 09gg (c) / 09gm. The "Customer update" section of the
 * CUSTOMER SUCCESS incident drawer (IncidentsLead.tsx `slots.customerMessage`):
 * the fixed template frame (read-only) around ONE editable paragraph, pre-filled
 * with the server's deterministic draft; inline plain-language lint and a
 * 600-character counter; the dedupe facts (a reconnect request inside 24 h, an
 * update already sent); a Preview that renders the full message and sends
 * nothing; and — ONLY when the read model says `sendEnabled: true` — a Send
 * control behind a confirmation that requires a reason. With `sendEnabled`
 * false the Send control is NOT RENDERED (S2: strict; hidden in Production).
 * A "Delivery status" list reads the incident's ledger rows (codes → words).
 * LAZY (S2 nit on #558): neither the read model nor the deliveries are fetched
 * on drawer mount — only on the section's FIRST expand (then kept; a send re-reads).
 *
 * CS ONLY: `IncidentCustomerUpdate` renders nothing for any other tier, and the
 * drawer passes it only on the CS tier. No recipient identity is ever shown:
 * the routes return none (`recipient.attributed` is a boolean) and this file
 * reads none. Collapsed by default with a one-line summary.
 */

import { useEffect, useState } from "react";
import { ChevronRight, Send } from "lucide-react";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";
import type { IncidentDetailDTO } from "@/lib/platform/incidents/investigation-dto";
import { OperatorReasonField, EMPTY_OPERATOR_REASON, reasonPayload, type OperatorReasonValue } from "../widgets/OperatorReasonField";
import {
  SEND_CONFIRM_MESSAGE, counterView, customerUpdatePath, customerUpdatePreviewPath, customerUpdateSendPath, dedupeView, deliveryLine,
  incidentDeliveriesPath, lintMessages, lintParagraph, sendOutcomeText, sendView, summaryLine,
  type CustomerUpdatePreview, type CustomerUpdateReadModel, type DeliveriesModel,
} from "./customer-update-model";

const H = "text-[11px] font-medium uppercase tracking-wide text-[var(--text-faint)]";
const FIELD = "min-h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-3 text-xs text-[var(--text-primary)] lg:min-h-8";
const PRIMARY_BTN = "min-h-11 min-w-0 rounded-[var(--radius-sm)] border border-[var(--meridian-400)] bg-[var(--meridian-400)] px-3 text-xs font-medium text-white disabled:opacity-50 lg:min-h-8";
const FRAME = "break-words rounded-[var(--radius-sm)] bg-[var(--surface-muted,transparent)] px-2 py-1.5 text-xs text-[var(--text-muted)]";

export interface CustomerUpdateSurfaceProps {
  model: CustomerUpdateReadModel | null;
  modelError?: string | null;
  deliveries: DeliveriesModel | null;
  deliveriesError?: string | null;
  paragraph: string;
  onParagraph: (p: string) => void;
  /** The incident's institution (the lint refuses naming it). */
  institution: string | null;
  canWrite: boolean;
  now: Date;
  preview: CustomerUpdatePreview | null;
  previewNote?: string | null;
  busy?: boolean;
  onPreview: () => void;
  onSend: () => void;
  outcome?: string | null;
  /** Test hook: render the disclosure open. */
  open?: boolean;
  /** LAZY: false ⇒ nothing has been requested yet (the section was never expanded). Absent ⇒ requested. */
  requested?: boolean;
  /** The disclosure was opened / closed by the operator (the container starts its reads on the first open). */
  onToggle?: (open: boolean) => void;
}

/** PROP-DRIVEN: every state renders in a test (customer-update-section.test.ts). */
export function CustomerUpdateSurface(p: CustomerUpdateSurfaceProps) {
  const m = p.model;
  const lint = m ? lintParagraph(p.paragraph, { verifiedRecovery: m.draft.verifiedRecovery, institution: p.institution }) : null;
  const counter = counterView(p.paragraph, m?.template.paragraphMax);
  const dd = m ? dedupeView(m, p.now) : null;
  const sv = m ? sendView(m, p.canWrite) : { showSend: false, blockedWords: [] };
  const problems = lint ? lintMessages(lint.codes) : [];

  return (
    <details className="group min-w-0 border-t border-[var(--border-hairline)] pt-3" data-customer-update open={p.open || undefined}
      onToggle={(e) => p.onToggle?.(e.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-xs text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--meridian-400)] lg:min-h-8 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] transition-transform group-open:rotate-90" />
        <span className={H}>Customer update</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]" data-customer-update-summary>{p.requested === false ? "Open to read the draft" : p.modelError ? `Unavailable — ${p.modelError}` : summaryLine(m, p.now)}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-3 pb-1 pt-2">
        {p.modelError ? <p className="text-[11px] text-[var(--text-muted)]">{`Customer update unavailable — ${p.modelError}`}</p>
          : !m ? <p className="text-[11px] text-[var(--text-muted)]">Reading the draft…</p>
          : (
            <>
              {(dd?.reauthLine || dd?.alreadySentLine) && (
                <div className="flex min-w-0 flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-2 text-xs" data-customer-update-dedupe>
                  {dd.alreadySentLine && <p className="break-words text-[var(--text-primary)]" data-customer-update-already-sent>{dd.alreadySentLine}</p>}
                  {dd.reauthLine && <p className="break-words text-[var(--text-secondary)]" data-customer-update-reauth={m.dedupe.reauthNotice?.outcome}>{dd.reauthLine}</p>}
                  {dd.reauthBlockLine && <p className="break-words text-[11px] text-[var(--text-muted)]" data-customer-update-reauth-block>{dd.reauthBlockLine}</p>}
                </div>
              )}

              <p className="text-[11px] text-[var(--text-muted)]">
                An in-app message to the customer. The title, opening and closing are fixed; only the middle paragraph can be edited.
              </p>
              <div className="flex min-w-0 flex-col gap-1.5" data-customer-update-template>
                <p className="break-words text-xs font-medium text-[var(--text-secondary)]" data-template-title>{m.template.title}</p>
                <p className={FRAME} data-template-opening>{m.template.opening}</p>
                <label className="flex min-w-0 flex-col gap-1 text-[11px] text-[var(--text-muted)]">
                  <span className="sr-only">Customer update paragraph</span>
                  <textarea className={`${FIELD} min-h-28 w-full resize-y px-2 py-1.5 text-base sm:text-xs`} value={p.paragraph} disabled={p.busy}
                    onChange={(e) => p.onParagraph(e.target.value)} aria-invalid={lint ? !lint.ok : undefined} data-customer-update-paragraph />
                  <span className={`self-end tabular-nums ${counter.over ? "text-[var(--status-bad,#c33)]" : "text-[var(--text-faint)]"}`} data-customer-update-counter>{counter.text}</span>
                </label>
                {problems.length > 0 && (
                  <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[11px] text-[var(--status-bad,#c33)]" data-customer-update-lint>
                    {problems.map((t) => <li key={t}>{t}</li>)}
                  </ul>
                )}
                <p className={FRAME} data-template-closing>{m.template.closing}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {p.canWrite ? (
                  <button type="button" className={FIELD} disabled={p.busy || !lint?.ok} onClick={p.onPreview} data-customer-update-preview-btn>Preview</button>
                ) : (
                  <p className="text-[11px] text-[var(--text-muted)]">Preview requires write access.</p>
                )}
                {sv.showSend && (
                  <button type="button" className={PRIMARY_BTN} aria-haspopup="dialog" onClick={p.onSend}
                    disabled={p.busy || !lint?.ok || sv.blockedWords.length > 0} data-customer-update-send>Send to customer…</button>
                )}
              </div>
              {sv.showSend && sv.blockedWords.length > 0 && (
                <p className="break-words text-[11px] text-[var(--text-muted)]" data-customer-update-blocked>{sv.blockedWords.join(" ")}</p>
              )}
              {p.previewNote && <p role="status" className="break-words text-[11px] text-[var(--text-muted)]">{p.previewNote}</p>}
              {p.outcome && <p role="status" className="break-words text-xs text-[var(--text-primary)]" data-customer-update-outcome>{p.outcome}</p>}

              {p.preview && (
                <div className="flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border-hairline)] p-3" data-customer-update-rendered>
                  <p className={H}>Preview · nothing is sent</p>
                  <p className="break-words text-sm font-medium text-[var(--text-primary)]">{p.preview.message.title}</p>
                  {p.preview.message.body.split("\n\n").map((para, i) => <p key={i} className="break-words text-xs text-[var(--text-secondary)]">{para}</p>)}
                  <p className="text-[11px] text-[var(--text-muted)]">Links to the Connections page.</p>
                </div>
              )}
            </>
          )}

        <div className="flex min-w-0 flex-col gap-1" data-customer-update-deliveries>
          <p className={H}>Delivery status</p>
          {p.deliveriesError ? <p className="text-[11px] text-[var(--text-muted)]">{`Unavailable — ${p.deliveriesError}`}</p>
            : !p.deliveries ? <p className="text-[11px] text-[var(--text-muted)]">Reading…</p>
            : p.deliveries.items.length === 0 ? <p className="text-[11px] text-[var(--text-muted)]">No update has been sent for this incident.</p>
            : (
              <ul className="flex min-w-0 flex-col">
                {p.deliveries.items.map((r) => {
                  const l = deliveryLine(r, p.now);
                  return (
                    <li key={l.key} className="min-w-0 border-l border-[var(--border-hairline)] py-1 pl-3" data-delivery-status={r.status}>
                      <span className="block break-words text-xs text-[var(--text-primary)]">{l.title}</span>
                      <span className="block break-words text-[10px] text-[var(--text-muted)]">{l.detail}</span>
                    </li>
                  );
                })}
              </ul>
            )}
        </div>
      </div>
    </details>
  );
}

async function readJson(r: Response): Promise<Record<string, unknown>> {
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

function errorWord(status: number): string {
  return status === 403 ? "Not authorized" : status === 404 ? "Not found" : `Request failed (${status})`;
}

/** The container: reads the routes and owns the paragraph, preview and send state. */
function CustomerUpdateContainer({ id, institution, canWrite }: { id: string; institution: string | null; canWrite: boolean }) {
  const [generation, setGeneration] = useState(0);
  const [model, setModel] = useState<CustomerUpdateReadModel | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveriesModel | null>(null);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [paragraph, setParagraph] = useState("");
  const [preview, setPreview] = useState<CustomerUpdatePreview | null>(null);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [why, setWhy] = useState<OperatorReasonValue>(EMPTY_OPERATOR_REASON);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  // Relative times ("3 h ago") are measured from the last read, not re-ticked.
  const [now, setNow] = useState(() => new Date());
  // LAZY (S2 nit): nothing is read until the section is first expanded.
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (!requested) return;
    let alive = true;
    fetch(customerUpdatePath(id), { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(errorWord(r.status));
        return (await r.json()) as CustomerUpdateReadModel;
      })
      .then((m) => {
        if (!alive) return;
        setNow(new Date());
        setModel(m);
        setModelError(null);
        // Pre-fill with the draft on first read only; a reload after a send keeps nothing stale.
        setParagraph((cur) => (cur === "" ? m.draft.paragraph : cur));
      })
      .catch((e: unknown) => { if (alive) setModelError(e instanceof Error ? e.message : "Failed to load"); });
    fetch(incidentDeliveriesPath(id), { credentials: "same-origin" })
      .then(async (r) => {
        if (!r.ok) throw new Error(errorWord(r.status));
        return (await r.json()) as DeliveriesModel;
      })
      .then((d) => { if (alive) { setDeliveries(d); setDeliveriesError(null); } })
      .catch((e: unknown) => { if (alive) setDeliveriesError(e instanceof Error ? e.message : "Failed to load"); });
    return () => { alive = false; };
  }, [id, generation, requested]);

  function edit(p: string) {
    setParagraph(p);
    setPreview(null);
    setPreviewNote(null);
  }

  async function runPreview() {
    setBusy(true);
    setPreviewNote(null);
    setPreview(null);
    try {
      const r = await fetch(customerUpdatePreviewPath(id), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paragraph }),
      });
      const body = await readJson(r);
      if (r.ok) setPreview(body as unknown as CustomerUpdatePreview);
      else if (r.status === 422) setPreviewNote("The paragraph didn't pass the message checks. See the notes above.");
      else if (r.status === 403) setPreviewNote("Not authorized (write access with a fresh sign-in is required).");
      else if (r.status === 429) setPreviewNote("Too many actions. Wait a minute and try again.");
      else setPreviewNote(typeof body.error === "string" ? body.error : `Preview failed (${r.status}).`);
    } catch {
      setPreviewNote("Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function runSend() {
    const reason = reasonPayload(why);
    if (!model || !reason) return;
    setBusy(true);
    setOutcome(null);
    try {
      const r = await fetch(customerUpdateSendPath(id), {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paragraph, reason, expectedDraftHash: model.draft.draftHash }),
      });
      setOutcome(sendOutcomeText(r.status, await readJson(r)));
    } catch {
      setOutcome("The send could not be confirmed. Check the delivery status before trying again.");
    } finally {
      setBusy(false);
      setConfirming(false);
      setGeneration((g) => g + 1);
    }
  }

  return (
    <>
      <CustomerUpdateSurface model={model} modelError={modelError} deliveries={deliveries} deliveriesError={deliveriesError}
        paragraph={paragraph} onParagraph={edit} institution={institution} canWrite={canWrite} now={now}
        preview={preview} previewNote={previewNote} busy={busy} onPreview={runPreview}
        onSend={() => { setWhy(EMPTY_OPERATOR_REASON); setOutcome(null); setConfirming(true); }} outcome={outcome}
        requested={requested} onToggle={(open) => { if (open) setRequested(true); }} />
      {confirming && model?.sendEnabled === true && (
        <ConfirmDialog icon={Send} title="Send this update to the customer?"
          message={<><span>{SEND_CONFIRM_MESSAGE}</span><OperatorReasonField value={why} onChange={setWhy} disabled={busy} label="A reason is recorded with this send" /></>}
          confirmLabel="Send" confirmTone="meridian" busy={busy} confirmDisabled={reasonPayload(why) === null}
          onConfirm={runSend} onClose={() => setConfirming(false)} />
      )}
    </>
  );
}

/** The drawer slot. CUSTOMER SUCCESS ONLY: any other tier renders nothing. */
export function IncidentCustomerUpdate({ d, canWrite }: { d: IncidentDetailDTO; canWrite: boolean }) {
  if (d.tier !== "cs") return null;
  return <CustomerUpdateContainer id={d.incident.id} institution={d.affected.institution ?? null} canWrite={canWrite} />;
}
