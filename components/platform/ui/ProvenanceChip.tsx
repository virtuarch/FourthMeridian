/**
 * components/platform/ui/ProvenanceChip.tsx  (Platform Operations 2.0 — R1 primitive)
 *
 * WHAT KIND of figure this is, and HOW FRESH: one chip per surface.
 *   MEASURED   counted from a persisted record (a ledger, an audit row)
 *   ESTIMATED  derived from measured inputs by a stated rule (tokens × rate card)
 *   ASSUMED    a configured or declared value, not observed
 *   UNKNOWN    no authority answered — never rendered as a zero or a colour
 * plus "as of HH:MM UTC" when the source reported the instant it answered.
 *
 * The kind is always a WORD (never colour alone); the tint is a quiet hint.
 * Pure, server-safe, no state.
 */

export type ProvenanceKind = "MEASURED" | "ESTIMATED" | "ASSUMED" | "UNKNOWN";

const KIND_WORD: Record<ProvenanceKind, string> = {
  MEASURED: "Measured",
  ESTIMATED: "Estimated",
  ASSUMED: "Assumed",
  UNKNOWN: "Unknown",
};

const KIND_COLOR: Record<ProvenanceKind, string> = {
  MEASURED: "var(--meridian-400)",
  ESTIMATED: "var(--brass-300)",
  ASSUMED: "var(--text-secondary)",
  UNKNOWN: "var(--text-faint)",
};

/** "14:02 UTC" for an ISO instant; null when unparseable (then no freshness is claimed). */
export function utcClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return `${new Date(t).toISOString().slice(11, 16)} UTC`;
}

/** The chip's full text, e.g. "Estimated · as of 14:02 UTC". */
export function provenanceText(kind: ProvenanceKind, asOf?: string | null): string {
  const clock = utcClock(asOf);
  return clock ? `${KIND_WORD[kind]} · as of ${clock}` : KIND_WORD[kind];
}

export function ProvenanceChip({ kind, asOf, title }: { kind: ProvenanceKind; asOf?: string | null; title?: string }) {
  const color = KIND_COLOR[kind];
  return (
    <span
      data-provenance={kind}
      title={title}
      className="inline-flex max-w-full shrink-0 items-center gap-1 truncate rounded-[var(--radius-xs)] border px-1.5 text-[10px] leading-4"
      style={{ color, borderColor: `color-mix(in srgb, ${color} 30%, transparent)` }}
    >
      {provenanceText(kind, asOf)}
    </span>
  );
}
