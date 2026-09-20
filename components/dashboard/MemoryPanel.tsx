"use client";

/**
 * components/dashboard/MemoryPanel.tsx
 *
 * WHAT FOURTH MERIDIAN REMEMBERS FOR YOU — see it, stop it, erase it.
 *
 * The smallest surface that makes durable memory defensible: a control on the AI
 * page that opens a dialog listing, in plain language, what the assistant has
 * noted for THIS user in THIS Space. Self-contained: one component, one fetch on
 * open, three routes under /api/ai/memory. It touches no navigation, no Settings
 * and no page chrome. It lives beside `AnalyzeClient` rather than in
 * `components/ai`, which is presentation-only by guard: this component fetches.
 *
 * ⚠️ MEMORY IS NOT YOUR FINANCES, AND THE PANEL SAYS SO EVERY TIME IT OPENS. What
 * is listed is what was NOTED, on the date shown — never a balance, and nothing
 * here changes any number unless the user asks the assistant to use it.
 *
 * ⚠️ "NOTED AS", NEVER "YOU SAID". The words kept with an item are the
 * assistant's paraphrase, not a transcript; the sentence above them is rendered
 * by code from the item's own fields.
 *
 * ⚠️ NO EDIT, NO CREATE, NO "USE THIS NOW". A form would be a second translation
 * of the rule vocabulary, and a button that ran a remembered rule would make
 * memory activate a scenario. To change something: tell the assistant, or delete
 * it and say it again.
 */

import { useCallback, useState } from "react";
import { BookMarked } from "lucide-react";
import { Dialog } from "@/components/atlas/Dialog";
import { ConfirmDialog } from "@/components/atlas/ConfirmDialog";

interface Item {
  id: string;
  class: string | null;
  state: string;
  inWords: string | null;
  notedAs: string;
  notedOn: string;
}
interface Listing {
  remembered: Item[]; planningFigures: Item[]; projections: Item[]; lapsed: Item[]; unreadable: Item[];
}

const SECTIONS: { key: keyof Listing; title: string; hint: string; canStop: boolean }[] = [
  { key: "remembered", title: "Remembered", hint: "Goals, plans and standing rules you asked the assistant to keep.", canStop: true },
  { key: "planningFigures", title: "Planning figures you gave — not measured from your accounts",
    hint: "Used only when you ask the assistant to plan with them. Your measured spending is always read fresh.", canStop: true },
  { key: "projections", title: "Projections the assistant made — not things you asked it to remember",
    hint: "What it told you to expect, kept so it can later check whether it was right.", canStop: false },
  { key: "lapsed", title: "Past their date", hint: "Still on record, no longer used.", canStop: true },
  { key: "unreadable", title: "Couldn’t be read reliably",
    hint: "Older notes saved in a form that can’t be trusted, so they are not used anywhere. Delete them, and tell the assistant again if they still matter.", canStop: false },
];

const day = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export function MemoryPanel({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [erasing, setErasing] = useState<Item | null>(null);

  const call = useCallback(async (input: string, init?: RequestInit) => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(input, { ...init, headers: { "Content-Type": "application/json" } });
      const body = await res.json().catch(() => null) as (Listing & { error?: string }) | null;
      if (!res.ok || !body) { setError(body?.error ?? "Something went wrong. Nothing was changed."); return; }
      setListing(body);
    } catch {
      setError("Something went wrong. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }, []);

  // Fetched on open, from the click — never on page load, and never from an effect.
  const openPanel = () => {
    setOpen(true);
    void call(`/api/ai/memory?spaceId=${encodeURIComponent(spaceId)}`);
  };

  const stop = (item: Item) => call(`/api/ai/memory/${encodeURIComponent(item.id)}`,
    { method: "PATCH", body: JSON.stringify({ spaceId, action: "retire" }) });
  const erase = async (item: Item) => {
    await call(`/api/ai/memory/${encodeURIComponent(item.id)}?spaceId=${encodeURIComponent(spaceId)}`, { method: "DELETE" });
    setErasing(null);
  };

  const empty = listing !== null && SECTIONS.every((s) => listing[s.key].length === 0);

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className="inline-flex items-center gap-1.5 h-8 rounded-lg px-2.5 text-xs font-medium transition-colors text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-info)]"
      >
        <BookMarked size={14} aria-hidden />
        <span className="max-sm:sr-only">Memory</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} size="md" title={`What Fourth Meridian remembers for you in ${spaceName}`}>
        <div className="space-y-5 text-sm">
          <p className="text-[var(--text-secondary)]">
            These are things the assistant noted for you, on the dates shown. They are not your current
            finances, and nothing here changes any number unless you ask the assistant to use it.
          </p>

          {error && <p role="alert" className="text-[var(--accent-negative)]">{error}</p>}
          {listing === null && !error && <p className="text-[var(--text-muted)]">Loading…</p>}
          {empty && <p className="text-[var(--text-muted)]">Nothing is remembered for you in this Space yet.</p>}

          {listing && SECTIONS.filter((s) => listing[s.key].length > 0).map((section) => (
            <section key={section.key} aria-label={section.title} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{section.title}</h3>
              <p className="text-xs text-[var(--text-muted)]">{section.hint}</p>
              <ul className="space-y-2">
                {listing[section.key].map((item) => (
                  <li key={item.id} className="rounded-xl border border-[var(--border-hairline)] p-3">
                    {item.inWords && <p className="text-[var(--text-primary)]">{item.inWords}</p>}
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Noted on {day(item.notedOn)}
                      {item.state === "STALE" ? " · you gave this a while ago — check it is still right" : ""}
                      {item.state === "NOT_YET" ? " · not in use yet" : ""}
                      {" · noted as: "}“{item.notedAs}”
                    </p>
                    <div className="mt-2 flex gap-3 text-xs">
                      {section.canStop && (
                        <button type="button" disabled={busy} onClick={() => void stop(item)}
                          className="font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50">
                          Stop using
                        </button>
                      )}
                      <button type="button" disabled={busy} onClick={() => setErasing(item)}
                        className="font-medium text-[var(--accent-negative)] hover:underline disabled:opacity-50">
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <p className="text-xs text-[var(--text-muted)]">
            To change something, tell the assistant — or delete it here and say it again.
          </p>
        </div>
      </Dialog>

      {erasing && (
        <ConfirmDialog
          onClose={() => setErasing(null)}
          onConfirm={() => void erase(erasing)}
          busy={busy}
          title="Delete this for good?"
          message="This erases it and every earlier version of it. It can’t be undone."
          confirmLabel="Delete"
        />
      )}
    </>
  );
}
