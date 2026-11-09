"use client";

/**
 * components/platform/RememberButton.tsx  (Platform AI operational memory — "Remember" on incident / job / provider pages)
 *
 * Design v2 §2 "Remember button", §5. Creates an OPERATOR_EXPLICIT fact about
 * ONE record the operator is looking at: POST /api/platform/ai/memory/remember
 * { area, kind, id, factType, ttl, concern?, note? }. The server re-reads the
 * record through the operator's FRESH reader for that area (its state is the
 * server's, never the page's), guards the note (no verbatim check: the operator
 * wrote it with no turn context), and the B2 trigger checks the ref.
 *
 * Renders NOTHING unless memory is effective: one probe per page load
 * (GET /api/platform/ai/memory?probe=1 — 404 when the flag is off), cached for
 * every button on the page. No content is logged.
 */

import { useEffect, useState } from "react";
import { validateOperatorNote } from "@/lib/platform/intelligence/ai/memory/note-guard";
import { MEMORY_NOTE_MAX, MEMORY_TTL_CHOICES, type MemoryFactType } from "@/lib/platform/intelligence/ai/memory/constants";
import { MEMORY_CONCERN_LABEL, MEMORY_TTL_LABEL, MEMORY_TYPE_LABEL, PLATFORM_AI_MEMORY_REMEMBER_URL, PLATFORM_AI_MEMORY_URL } from "./platform-ai-memory-model";
import { NOTE_REFUSAL_COPY } from "./PlatformAiMemory";

export type RememberKind = "INCIDENT" | "JOB" | "PROVIDER";
const TYPES: readonly MemoryFactType[] = ["WATCHING_ISSUE", "FOLLOW_UP", "OPERATIONAL_STATE"];

let probe: Promise<boolean> | null = null;
/** True when memory is effective for this operator (the list route answers; off ⇒ 404). Cached per page load. */
export function memoryAvailable(): Promise<boolean> {
  probe ??= fetch(`${PLATFORM_AI_MEMORY_URL}?probe=1`, { credentials: "same-origin", cache: "no-store" })
    .then((r) => r.status === 200).catch(() => false);
  return probe;
}

export interface RememberFormViewProps {
  kind: RememberKind;
  factType: MemoryFactType;
  concern: string;
  note: string;
  ttl: string;
  busy: boolean;
  status: string | null;
  onType: (t: MemoryFactType) => void;
  onConcern: (c: string) => void;
  onNote: (n: string) => void;
  onTtl: (t: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** PURE — the inline form. */
export function RememberFormView(p: RememberFormViewProps) {
  const guard = validateOperatorNote(p.note);
  const refusal = guard.ok ? null : NOTE_REFUSAL_COPY[guard.reason] ?? "That note can't be saved.";
  const choices = MEMORY_TTL_CHOICES[p.factType];
  const field = "rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-base)] px-2 py-0.5 text-xs text-[var(--text-primary)]";
  return (
    <div role="group" aria-label="Remember this" data-platform-ai-remember-form={p.kind} className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border-hairline)] p-2 text-xs">
      <label className="text-[var(--text-secondary)]">Type{" "}
        <select className={field} value={p.factType} disabled={p.busy} onChange={(e) => p.onType(e.target.value as MemoryFactType)}>
          {TYPES.map((t) => <option key={t} value={t}>{MEMORY_TYPE_LABEL[t]}</option>)}
        </select>
      </label>
      <label className="text-[var(--text-secondary)]">Concern{" "}
        <select className={field} value={p.concern} disabled={p.busy} onChange={(e) => p.onConcern(e.target.value)}>
          <option value="">None</option>
          {Object.entries(MEMORY_CONCERN_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label className="text-[var(--text-secondary)]">Note (optional){" "}
        <input type="text" className={`${field} w-full`} value={p.note} maxLength={MEMORY_NOTE_MAX} disabled={p.busy} onChange={(e) => p.onNote(e.target.value)} aria-invalid={refusal !== null} />
      </label>
      {refusal ? <p role="status" className="text-[var(--text-primary)]">{refusal}</p> : null}
      <label className="text-[var(--text-secondary)]">Keep for{" "}
        <select className={field} value={p.ttl} disabled={p.busy || choices.length === 1} onChange={(e) => p.onTtl(e.target.value)}>
          {choices.map((t) => <option key={t} value={t}>{MEMORY_TTL_LABEL[t]}</option>)}
        </select>
      </label>
      {p.status ? <p role="status" data-platform-ai-remember-status="" className="text-[var(--text-primary)]">{p.status}</p> : null}
      <div className="flex gap-3">
        <button type="button" className="font-medium underline underline-offset-2 text-[var(--text-primary)] disabled:opacity-50" disabled={p.busy || refusal !== null} onClick={p.onSave}>Remember</button>
        <button type="button" className="underline underline-offset-2 text-[var(--text-secondary)]" disabled={p.busy} onClick={p.onCancel}>Not now</button>
      </div>
    </div>
  );
}

export function RememberButton({ area, kind, id }: { area: string; kind: RememberKind; id: string }) {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [factType, setFactType] = useState<MemoryFactType>("WATCHING_ISSUE");
  const [concern, setConcern] = useState("");
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState("D7");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { let live = true; void memoryAvailable().then((v) => { if (live) setAvailable(v); }); return () => { live = false; }; }, []);
  if (!available) return null;
  if (!open) {
    return (
      <button type="button" data-platform-ai-remember={kind} onClick={() => { setOpen(true); setStatus(null); }}
        className="text-xs font-medium underline underline-offset-2 text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
        Remember
      </button>
    );
  }
  const onType = (t: MemoryFactType) => { setFactType(t); const c = MEMORY_TTL_CHOICES[t]; if (!c.includes(ttl as never)) setTtl(c[0]); };
  async function save() {
    setBusy(true); setStatus(null);
    const trimmed = note.trim();
    let r: Response | null = null;
    try {
      r = await fetch(PLATFORM_AI_MEMORY_REMEMBER_URL, {
        method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area, kind, id, factType, ttl, concern: concern || null, note: trimmed === "" ? null : trimmed }),
      });
    } catch { r = null; }
    setBusy(false);
    if (r && r.status === 201) { setOpen(false); setNote(""); setStatus(null); return; }
    const code = r ? ((await r.json().catch(() => null)) as { code?: unknown } | null)?.code : null;
    setStatus(typeof code === "string" && NOTE_REFUSAL_COPY[code] ? NOTE_REFUSAL_COPY[code] : "Couldn’t save this. Try again.");
  }
  return (
    <RememberFormView kind={kind} factType={factType} concern={concern} note={note} ttl={ttl} busy={busy} status={status}
      onType={onType} onConcern={setConcern} onNote={setNote} onTtl={setTtl} onSave={() => void save()} onCancel={() => setOpen(false)} />
  );
}
