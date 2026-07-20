/**
 * components/dashboard/CurrencyRevertedBanner.tsx — V25-CLOSE-3A
 *
 * The one non-blocking disclosure for the reporting-currency failure contract.
 * Shown at the Space composition root when the requested reporting currency
 * could not be satisfied (no exchange-rate data) and the DISPLAY fell back to a
 * valid currency. It must communicate four things and nothing more:
 *   - conversion is unavailable,
 *   - the display fell back (to `effective`),
 *   - the stored preference was NOT deleted,
 *   - balances remain accurate.
 *
 * It renders nothing on its own decision — the parent gates it on `reverted`.
 */
export function CurrencyRevertedBanner({
  requested,
  effective,
}: {
  requested: string;
  effective: string;
}) {
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-2xl border px-4 py-3"
      style={{
        background:  "var(--surface-muted)",
        borderColor: "var(--border-hairline-strong)",
      }}
    >
      <span
        aria-hidden
        className="mt-0.5 shrink-0 text-sm"
        style={{ color: "var(--accent-warning)" }}
      >
        ⚠
      </span>
      <p className="text-xs leading-relaxed text-[var(--text-secondary)]">
        <span className="font-semibold text-[var(--text-primary)]">
          {requested} conversion is temporarily unavailable
        </span>{" "}
        because exchange-rate data is missing. We&rsquo;ve returned to {effective} to keep
        your balances accurate. Your {requested} preference is saved and will resume
        automatically when rates are available.
      </p>
    </div>
  );
}
