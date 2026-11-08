"use client";

/**
 * components/platform/PlatformAiMemory.tsx  (Platform AI operational memory — the panel and the confirm card)
 *
 * Design v2 §5. Rendered ONLY when memory is effective (the page decides it
 * server-side; every API route re-checks the flag first and answers 404).
 *
 *   PlatformAiMemoryPanelView   PURE (props only, DOM-less tests walk it): the
 *       §5 header line + a link to the §9 notice; rows grouped by HELD area;
 *       each row: type, the LIVE subject label (resolved by the server through
 *       the current reader, never stored text), concern, note, "noted <date>",
 *       "expires <date>", and a badge (Unchanged / Changed / Updated / Gone /
 *       Unverified). A GONE row shows its type only (no label, no link, no note).
 *       Actions: Delete; "Still relevant: renew"; "Delete all my memory".
 *   PlatformAiMemoryPanel       the container: GET / DELETE / renew calls.
 *   PlatformAiMemoryConfirmCard the card an answer may end with: type, subject,
 *       concern, an editable note (140 characters, live guard), a TTL picker
 *       (OPERATIONAL_STATE fixed 72 h; others 7 d or 30 d), Remember / Not now.
 *
 * Nothing here logs content. Every piece of text is rendered as React text.
 */

import { useCallback, useEffect, useState } from "react";
import { validateOperatorNote } from "@/lib/platform/intelligence/ai/memory/note-guard";
import { MEMORY_NOTE_MAX } from "@/lib/platform/intelligence/ai/memory/constants";
import {
  MEMORY_BADGE_LABEL, MEMORY_CONCERN_LABEL, MEMORY_TTL_LABEL, MEMORY_TYPE_LABEL,
  PLATFORM_AI_MEMORY_CONFIRM_URL, PLATFORM_AI_MEMORY_NOTICE, PLATFORM_AI_MEMORY_NOTICE_ID, PLATFORM_AI_MEMORY_NOTICE_TITLE,
  PLATFORM_AI_MEMORY_PANEL_HEADER, PLATFORM_AI_MEMORY_RENEW_CHANGED,
  PLATFORM_AI_MEMORY_URL, expiresLabel, memoryFactUrl, memoryRenewUrl, parsePanel, parsePanelMore,
  type ClientMemoryArea, type ClientMemoryProposal, type ClientMemoryRow,
} from "./platform-ai-memory-model";

const BTN = "rounded-full border border-[var(--border-hairline-strong)] px-3 py-1 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--surface-hover)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]";
const QUIET = "text-xs underline underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50";

/** The guard's refusal, in words (client-side live guard; the server re-runs it). */
export const NOTE_REFUSAL_COPY: Readonly<Record<string, string>> = {
  NOTE_TOO_LONG: "That note is too long.",
  NOTE_IDENTIFIER: "Remove ids and numbers of four or more digits.",
  NOTE_LINK: "Remove emails, links and braces.",
  NOTE_IDENTITY: "Remove customer identifiers.",
  NOTE_AMOUNT: "Remove amounts and percentages.",
  NOTE_VERBATIM: "Write the note in your own words.",
  NOTE_EDIT_UNAVAILABLE: "Keep the proposed note or clear it.",
};

function Badge({ badge }: { badge: string }) {
  return (
    <span data-platform-ai-memory-badge={badge}
      className={`inline-flex items-center rounded-full border px-1.5 text-[10px] leading-4 ${badge === "CHANGED" || badge === "GONE" ? "border-[var(--accent-warning)] text-[var(--text-primary)]" : "border-[var(--border-hairline)] text-[var(--text-secondary)]"}`}>
      {MEMORY_BADGE_LABEL[badge] ?? badge}
    </span>
  );
}

export interface MemoryRowProps {
  row: ClientMemoryRow;
  busy: boolean;
  renewRefused: boolean;
  onDelete: (id: string) => void;
  onRenew: (id: string) => void;
}

export function PlatformAiMemoryRow({ row, busy, renewRefused, onDelete, onRenew }: MemoryRowProps) {
  const gone = row.badge === "GONE";
  return (
    <li data-platform-ai-memory-row={row.id} className="min-w-0 space-y-1 rounded-lg border border-[var(--border-hairline)] p-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-[var(--text-primary)]">{MEMORY_TYPE_LABEL[row.type] ?? row.type}</span>
        {!gone && row.subject ? <span data-platform-ai-memory-subject="" className="min-w-0 break-words text-[var(--text-primary)]">{row.subject}</span> : null}
        <Badge badge={row.badge} />
      </div>
      {!gone && row.concern ? <p className="text-xs text-[var(--text-secondary)]">{MEMORY_CONCERN_LABEL[row.concern] ?? row.concern}</p> : null}
      {!gone && row.note ? <p data-platform-ai-memory-note="" className="min-w-0 break-words text-xs text-[var(--text-primary)]">{row.note}</p> : null}
      <p className="text-[11px] text-[var(--text-secondary)]">{row.noted} · {expiresLabel(row.expiresAt)}</p>
      {renewRefused ? <p role="status" data-platform-ai-memory-renew-refused="" className="text-xs text-[var(--text-primary)]">{PLATFORM_AI_MEMORY_RENEW_CHANGED}</p> : null}
      <div className="flex flex-wrap gap-3">
        <button type="button" className={QUIET} disabled={busy} onClick={() => onDelete(row.id)}>Delete</button>
        {row.canRenew ? <button type="button" className={QUIET} disabled={busy} onClick={() => onRenew(row.id)}>Still relevant: renew</button> : null}
      </div>
    </li>
  );
}

export interface MemoryPanelViewProps {
  areas: readonly ClientMemoryArea[] | null;
  error: string | null;
  busy: boolean;
  confirmAll: boolean;
  renewRefused: ReadonlySet<string>;
  onDelete: (id: string) => void;
  onRenew: (id: string) => void;
  onAskDeleteAll: (ask: boolean) => void;
  onDeleteAll: () => void;
  /** The §9 notice, expanded inline under the header. */
  noticeOpen: boolean;
  onNotice: (open: boolean) => void;
  /** S2 C5: how many older items are not shown (newest 50 only). */
  more?: number;
}

/** PURE — every state renders from props. */
export function PlatformAiMemoryPanelView(p: MemoryPanelViewProps) {
  const empty = p.areas !== null && p.areas.length === 0;
  return (
    <section data-platform-ai-memory-panel="" aria-label="Platform AI memory" className="min-w-0 space-y-3">
      <p data-platform-ai-memory-header="" className="min-w-0 break-words text-xs leading-relaxed text-[var(--text-secondary)]">
        {PLATFORM_AI_MEMORY_PANEL_HEADER}{" "}
        <button type="button" data-platform-ai-memory-notice-link="" aria-expanded={p.noticeOpen} aria-controls={PLATFORM_AI_MEMORY_NOTICE_ID}
          onClick={() => p.onNotice(!p.noticeOpen)} className="font-medium text-[var(--text-primary)] underline underline-offset-2">How memory works</button>
      </p>
      <div id={PLATFORM_AI_MEMORY_NOTICE_ID} data-platform-ai-memory-notice={p.noticeOpen ? "open" : "closed"} hidden={!p.noticeOpen}
        className="min-w-0 break-words text-xs leading-relaxed text-[var(--text-secondary)]">
        <p><strong className="text-[var(--text-primary)]">{PLATFORM_AI_MEMORY_NOTICE_TITLE}</strong> {PLATFORM_AI_MEMORY_NOTICE}</p>
      </div>
      {p.error ? <p role="status" className="text-sm text-[var(--text-secondary)]">{p.error}</p> : null}
      {p.areas === null && !p.error ? <p className="text-sm text-[var(--text-secondary)]">Loading…</p> : null}
      {empty ? <p data-platform-ai-memory-empty="" className="text-sm text-[var(--text-secondary)]">Nothing remembered yet.</p> : null}
      {(p.areas ?? []).map((a) => (
        <div key={a.area} data-platform-ai-memory-area={a.area} className="min-w-0 space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">{a.areaLabel}</h3>
          <ul className="min-w-0 space-y-2">
            {a.facts.map((f) => <PlatformAiMemoryRow key={f.id} row={f} busy={p.busy} renewRefused={p.renewRefused.has(f.id)} onDelete={p.onDelete} onRenew={p.onRenew} />)}
          </ul>
        </div>
      ))}
      {p.more && p.more > 0 ? <p data-platform-ai-memory-more="" className="text-xs text-[var(--text-secondary)]">{`${p.more} older item${p.more === 1 ? "" : "s"} not shown.`}</p> : null}
      {p.areas && p.areas.length > 0 ? (
        p.confirmAll ? (
          <div role="group" aria-label="Delete all my memory" className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--text-primary)]">Delete every remembered item?</span>
            <button type="button" className={BTN} disabled={p.busy} onClick={p.onDeleteAll}>Delete all</button>
            <button type="button" className={QUIET} disabled={p.busy} onClick={() => p.onAskDeleteAll(false)}>Cancel</button>
          </div>
        ) : (
          <button type="button" data-platform-ai-memory-delete-all="" className={QUIET} disabled={p.busy} onClick={() => p.onAskDeleteAll(true)}>Delete all my memory</button>
        )
      ) : null}
    </section>
  );
}

async function call(url: string, init?: RequestInit): Promise<{ status: number; body: unknown } | null> {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  } catch { return null; }
}

/** The container: the panel's three calls. Re-read after every change (the server re-checks live). */
export function PlatformAiMemoryPanel() {
  const [areas, setAreas] = useState<ClientMemoryArea[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [renewRefused, setRenewRefused] = useState<ReadonlySet<string>>(new Set());
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [more, setMore] = useState(0);

  const load = useCallback(async () => {
    const r = await call(PLATFORM_AI_MEMORY_URL);
    const parsed = r && r.status === 200 ? parsePanel(r.body) : null;
    if (!parsed) { setError("Memory is unavailable right now."); setAreas((a) => a ?? []); return; }
    setError(null); setAreas(parsed); setMore(parsePanelMore(r?.body));
  }, []);
  // The first read (an external system); setState runs after the awaited fetch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const act = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } finally { setBusy(false); } };
  return (
    <PlatformAiMemoryPanelView
      areas={areas} error={error} busy={busy} confirmAll={confirmAll} renewRefused={renewRefused} noticeOpen={noticeOpen} onNotice={setNoticeOpen} more={more}
      onDelete={(id) => void act(async () => { await call(memoryFactUrl(id), { method: "DELETE" }); await load(); })}
      onRenew={(id) => void act(async () => {
        const r = await call(memoryRenewUrl(id), { method: "POST" });
        if (r && r.status === 409) setRenewRefused((s) => new Set([...s, id]));
        else await load();
      })}
      onAskDeleteAll={setConfirmAll}
      onDeleteAll={() => void act(async () => { await call(PLATFORM_AI_MEMORY_URL, { method: "DELETE" }); setConfirmAll(false); await load(); })}
    />
  );
}

// ── The confirm card (design §5) ────────────────────────────────────────────

export interface ConfirmCardProps {
  proposal: ClientMemoryProposal;
  onDone: (saved: boolean) => void;
  /** Test seam: the POST (defaults to fetch). */
  post?: (payload: Record<string, unknown>) => Promise<{ status: number; body: unknown } | null>;
}

export interface ConfirmCardViewProps {
  proposal: ClientMemoryProposal;
  note: string;
  ttl: string;
  busy: boolean;
  problem: string | null;
  onNote: (v: string) => void;
  onTtl: (v: string) => void;
  onRemember: () => void;
  onNotNow: () => void;
}

/** PURE — the card as rendered. The note's guard result is shown live; Remember is disabled while it refuses. */
export function PlatformAiMemoryConfirmCardView(p: ConfirmCardViewProps) {
  const guard = validateOperatorNote(p.note);
  const refusal = guard.ok ? null : NOTE_REFUSAL_COPY[guard.reason] ?? "That note can't be saved.";
  const fixed = p.proposal.ttlChoices.length === 1;
  return (
    <div role="group" aria-label="Remember this?" data-platform-ai-memory-card=""
      className="mx-auto mb-2 w-full min-w-0 max-w-3xl space-y-2 rounded-xl border border-[var(--border-hairline-strong)] bg-[var(--surface-inset)] p-3 text-sm">
      <p className="font-medium text-[var(--text-primary)]">Remember this?</p>
      <p className="min-w-0 break-words text-[var(--text-primary)]">
        <span>{MEMORY_TYPE_LABEL[p.proposal.factType] ?? p.proposal.factType}</span>
        <span aria-hidden> · </span>
        <span data-platform-ai-memory-card-subject="">{p.proposal.subjectLabel}</span>
        {p.proposal.concern ? <><span aria-hidden> · </span><span>{MEMORY_CONCERN_LABEL[p.proposal.concern] ?? p.proposal.concern}</span></> : null}
      </p>
      <label className="block text-xs text-[var(--text-secondary)]">
        Note (optional, {MEMORY_NOTE_MAX} characters)
        <input type="text" value={p.note} maxLength={MEMORY_NOTE_MAX} onChange={(e) => p.onNote(e.target.value)} disabled={p.busy}
          aria-invalid={refusal !== null} aria-describedby={refusal ? "platform-ai-memory-note-guard" : undefined}
          className="mt-1 block w-full min-w-0 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-base)] px-2 py-1 text-sm text-[var(--text-primary)]" />
      </label>
      {refusal ? <p id="platform-ai-memory-note-guard" role="status" data-platform-ai-memory-note-guard="" className="text-xs text-[var(--text-primary)]">{refusal}</p> : null}
      <label className="block text-xs text-[var(--text-secondary)]">
        Keep for
        <select value={p.ttl} onChange={(e) => p.onTtl(e.target.value)} disabled={p.busy || fixed}
          className="ml-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-base)] px-2 py-0.5 text-sm text-[var(--text-primary)]">
          {p.proposal.ttlChoices.map((t) => <option key={t} value={t}>{MEMORY_TTL_LABEL[t] ?? t}</option>)}
        </select>
      </label>
      {p.problem ? <p role="status" data-platform-ai-memory-card-problem="" className="text-xs text-[var(--text-primary)]">{p.problem}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={p.busy || refusal !== null} onClick={p.onRemember}>Remember</button>
        <button type="button" className={QUIET} disabled={p.busy} onClick={p.onNotNow}>Not now</button>
      </div>
    </div>
  );
}

const postConfirm = async (payload: Record<string, unknown>) =>
  call(PLATFORM_AI_MEMORY_CONFIRM_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

export function PlatformAiMemoryConfirmCard({ proposal, onDone, post = postConfirm }: ConfirmCardProps) {
  const [note, setNote] = useState(proposal.note ?? "");
  const [ttl, setTtl] = useState(proposal.ttlChoices[proposal.ttlChoices.length - 1] ?? proposal.ttlChoices[0]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  async function remember() {
    setBusy(true); setProblem(null);
    const trimmed = note.trim();
    const r = await post({ token: proposal.token, ttl, note: trimmed === "" ? null : trimmed });
    setBusy(false);
    if (r && r.status === 201) { onDone(true); return; }
    const code = r && typeof r.body === "object" && r.body !== null ? (r.body as { code?: unknown }).code : null;
    setProblem(typeof code === "string" && NOTE_REFUSAL_COPY[code] ? NOTE_REFUSAL_COPY[code]
      : code === "RECORD_CHANGED" ? "This has changed since it was proposed. Ask again to save the current state."
        : code === "REPLAY" ? "Already saved."
          : code === "RECORD_UNVERIFIED" ? "Couldn't check the record right now — try again"
            : code === "PROPOSAL_EXPIRED" ? "This suggestion expired — ask again" : "Couldn’t save this. Try again.");
  }
  return (
    <PlatformAiMemoryConfirmCardView proposal={proposal} note={note} ttl={ttl} busy={busy} problem={problem}
      onNote={setNote} onTtl={setTtl} onRemember={() => void remember()} onNotNow={() => onDone(false)} />
  );
}
