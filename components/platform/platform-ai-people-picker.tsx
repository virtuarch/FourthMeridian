"use client";

/**
 * components/platform/platform-ai-people-picker.tsx  (Platform AI — the @ people picker in the composer, owner 2026-11-10)
 *
 * Typing `@` in the Platform AI composer opens a suggestion list; from 3 characters it asks
 * POST /api/platform/ai/people (P5 authority, the shared P5 limiter, the uniform empty response, the
 * 300 ms floor — S2 09fc P1–P6). Picking a customer inserts `@label` into the draft and remembers the chip
 * { ref, label } IN THIS COMPONENT'S MEMORY ONLY. What is SENT is serializeDraft(draft, chips): every chip
 * mention ⇒ `[[cust:<ref>]]` (authz/people-chip.ts) — the label never leaves this tab (P3). The server
 * resolves the chip through the existing OPAQUE_REF slot path (a handle for the model, `[customer]` stored).
 *
 * Keyboard: ↑ / ↓ move, Enter or Tab picks, Escape closes; the input is an ARIA combobox over a listbox.
 * Mobile: the list is the composer's width (390 px safe), above the pill.
 *
 * The hint (no lookup): an email-shaped string in the SERIALISED draft shows the reminder before send.
 * Nothing here is persisted or logged.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type AriaAttributes, type AriaRole, type KeyboardEvent, type ReactNode } from "react";
import {
  EMAIL_REMINDER, PEOPLE_PICKER_REMINDER, USE_PEOPLE_PICKER, activeMention, chipMention, hasEmailShaped, insertChip, liveChips, serializeDraft,
  type DraftChip,
} from "@/lib/platform/intelligence/ai/authz/people-chip";

export const PLATFORM_AI_PEOPLE_URL = "/api/platform/ai/people";
const SEARCH_DEBOUNCE_MS = 300;
const QUERY_MIN = 3;

export interface PeopleMatchView { opaqueRef: string; label: string }

/** What the composer needs from the picker (ComposerFrame's intercept / caret / ARIA / overlay seams). */
export interface PeoplePickerBinding {
  onKeyIntercept: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onCaret: (caret: number) => void;
  inputAria: Readonly<AriaAttributes & { role?: AriaRole }>;
  overlay: ReactNode;
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  /** The reminder to show under the composer now (the client hint), or null. */
  hint: string | null;
}

async function searchPeople(q: string): Promise<PeopleMatchView[]> {
  try {
    const r = await fetch(PLATFORM_AI_PEOPLE_URL, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q }),
    });
    if (!r.ok) return [];
    const body = await r.json().catch(() => null) as { matches?: unknown } | null;
    if (!body || !Array.isArray(body.matches)) return [];
    return body.matches.filter((m): m is PeopleMatchView =>
      !!m && typeof (m as PeopleMatchView).opaqueRef === "string" && /^[0-9a-f]{8}$/.test((m as PeopleMatchView).opaqueRef) && typeof (m as PeopleMatchView).label === "string").slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * The picker's state for one composer. `enabled` = the page offers Customer Success lookup (the same
 * server-decided flag as the customer notice); disabled ⇒ no `@` list, the email hint only.
 */
export function usePeoplePicker({ enabled, draft, setDraft }: { enabled: boolean; draft: string; setDraft: (v: string) => void }) {
  const listId = useId();
  const [chips, setChips] = useState<DraftChip[]>([]);
  const [caret, setCaret] = useState(0);
  const [matches, setMatches] = useState<{ query: string; items: PeopleMatchView[] } | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  /** Queries already answered (memory only); a query that found nothing ⇒ its extensions find nothing either. */
  const cache = useRef(new Map<string, PeopleMatchView[]>());

  const mention = useMemo(() => (enabled ? activeMention(draft, caret) : null), [enabled, draft, caret]);
  const query = mention && mention.start !== dismissedAt ? mention.query.toLowerCase() : null;

  useEffect(() => {
    if (query === null || query.length < QUERY_MIN) return;
    const hit = cache.current.get(query);
    const emptyPrefix = [...cache.current.entries()].some(([k, v]) => v.length === 0 && query.startsWith(k));
    if (hit || emptyPrefix) {
      const items = hit ?? [];
      const t0 = setTimeout(() => { setMatches({ query, items }); setActive(0); }, 0);
      return () => clearTimeout(t0);
    }
    let live = true;
    const t = setTimeout(() => {
      void searchPeople(query).then((items) => {
        cache.current.set(query, items);
        if (live) { setMatches({ query, items }); setActive(0); }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  // Place the caret after a picked chip (the draft update renders first).
  useEffect(() => {
    if (pendingCaret.current === null || !inputRef.current) return;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(at, at);
  }, [draft]);

  const items = useMemo(() => (query !== null && query.length >= QUERY_MIN && matches?.query === query ? matches.items : []), [query, matches]);
  const open = items.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const pick = useCallback((m: PeopleMatchView) => {
    if (!mention) return;
    const next = insertChip(draft, mention, m.label);
    setChips((cs) => (cs.some((c) => c.label === m.label) ? cs.map((c) => (c.label === m.label ? { ref: m.opaqueRef, label: m.label } : c)) : [...cs, { ref: m.opaqueRef, label: m.label }]));
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setMatches(null);
    setDraft(next.draft);
  }, [mention, draft, setDraft]);

  const onKeyIntercept = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % items.length); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + items.length) % items.length); return true; }
    if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
      e.preventDefault(); pick(items[Math.min(active, items.length - 1)]); return true;
    }
    if (e.key === "Escape") { e.preventDefault(); setDismissedAt(mention?.start ?? null); return true; }
    return false;
  }, [open, items, active, pick, mention]);

  const live = liveChips(draft, chips);
  const serialized = serializeDraft(draft, live);
  const hint = hasEmailShaped(serialized) ? (enabled ? PEOPLE_PICKER_REMINDER : EMAIL_REMINDER) : null;

  const overlay = open ? (
    <ul id={listId} role="listbox" aria-label="Customers"
      data-platform-ai-people-list=""
      className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-64 min-w-0 overflow-y-auto rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-raised,var(--bg-base))] p-1 shadow-lg">
      {items.map((m, i) => (
        <li key={m.opaqueRef} id={optionId(i)} role="option" aria-selected={i === active}
          onMouseDown={(e) => { e.preventDefault(); pick(m); }}
          onMouseEnter={() => setActive(i)}
          className={`flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm ${i === active ? "bg-[var(--surface-hover)] text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>
          <span className="min-w-0 flex-1 truncate">{chipMention(m.label)}</span>
          <span className="shrink-0 text-xs tabular-nums text-[var(--text-muted)]">user #{m.opaqueRef}</span>
        </li>
      ))}
    </ul>
  ) : null;

  const binding: PeoplePickerBinding = {
    onKeyIntercept,
    onCaret: (c) => { setCaret(c); if (dismissedAt !== null && mention?.start !== dismissedAt) setDismissedAt(null); },
    inputAria: enabled ? {
      role: "combobox", "aria-autocomplete": "list", "aria-expanded": open, "aria-controls": open ? listId : undefined,
      "aria-activedescendant": open ? optionId(Math.min(active, items.length - 1)) : undefined,
    } : {},
    overlay,
    textareaRef: (el) => { inputRef.current = el; },
    hint,
  };

  return {
    binding,
    /** The text to SEND (chips ⇒ tokens; never a label). */
    serialize: () => serializeDraft(draft, liveChips(draft, chips)),
    /** Any text (a trimmed draft, a starter prompt) ⇒ what to send: its live chip mentions ⇒ tokens. */
    serializeText: (text: string) => serializeDraft(text, liveChips(text, chips)),
    /** The server's USE_PEOPLE_PICKER refusal: its code, and the reminder for this page. */
    isGuardRefusal: (body: unknown) => (body as { reason?: unknown } | null)?.reason === USE_PEOPLE_PICKER,
    guardReminder: enabled ? PEOPLE_PICKER_REMINDER : EMAIL_REMINDER,
    /** The chips this operator picked (memory only) — to show their own sent question with labels. */
    chips: live,
    /** After a successful send: forget the chips (a refusal keeps them, with the draft). */
    reset: () => { setChips([]); setMatches(null); setDismissedAt(null); },
  };
}
