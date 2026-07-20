/**
 * components/ui/FxUnavailableNote.tsx — V25-CLOSE-3 Part 1
 *
 * The unmistakable disclosure for the case a quiet "est." marker under-states:
 * a value shown in the display currency for which NO exchange rate was available,
 * so the number is the NATIVE amount passed through (per FX doctrine D-3: never
 * exclude, never throw). "$1,000,000" that is really ¥1,000,000 must not read as
 * an authoritative converted figure.
 *
 * This changes NO conversion math and creates NO FX authority — it renders the
 * `fxDisclosureOf(...) === "unavailable"` / `ConvertedTotal.unconverted` signal
 * the money layer already produces. It sits BELOW the value (a note, not an
 * inline glyph) precisely because the glyph is what proved insufficient.
 *
 * Use EstimatedChip / the "≈ est." marker for the softer "estimated" case (a real
 * rate applied but walked back in time). Use THIS only for "unavailable".
 */
export function FxUnavailableNote({ className = "" }: { className?: string }) {
  return (
    <p
      className={`text-[11px] leading-snug text-[var(--accent-warning,var(--text-muted))] ${className}`}
      role="note"
    >
      Exchange rate unavailable — showing native amounts, not a converted value.
    </p>
  );
}
