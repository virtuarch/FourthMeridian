"use client";

/**
 * components/connections/PropertyEquityPanel.tsx  (Mortgage F9 — owner 2026-11-08)
 *
 * Inside a manual asset's Overview: the property's market value, the mortgage /
 * HELOC / home-equity debts linked as secured by it (with balances), the DERIVED
 * equity (value − linked secured debt), the value-basis control, and link /
 * unlink. Reads and writes GET/PATCH /api/accounts/manual/[id]/property.
 *
 *   · Only secured kinds in the same Space are offered (the API decides).
 *   · Exactly one candidate ⇒ a SUGGESTION the user must confirm — never a
 *     silent link.
 *   · Double-count prompt ⇒ a disclosure plus one-click "market value / equity".
 *     Nothing is excluded or restated; net worth keeps counting the property at
 *     its value and the mortgage as debt.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { formatCurrencyWhole } from "@/lib/currency";
import {
  doubleCountDisclosure, SECURED_DEBT_KIND_LABEL,
  type PropertyEquity, type PropertyValueBasis, type SecuredDebtKind,
} from "@/lib/assets/property-equity";
import { Facts, SectionLabel } from "@/components/connections/ConnectionDetailTabs";

interface View {
  accountId: string;
  canLinkSecuredDebt: boolean;
  equity: PropertyEquity;
  candidates: { id: string; name: string; kind: SecuredDebtKind; amountOwed: number; currency: string }[];
  suggestedDebtId: string | null;
}

const BASIS_LABEL: Record<PropertyValueBasis, string> = {
  MARKET_VALUE:   "Market value",
  EQUITY_ENTERED: "Equity (value minus mortgage)",
  UNKNOWN:        "Not confirmed",
};

const BTN = "rounded-[var(--radius-sm)] border border-[var(--border-hairline)] px-2.5 py-1 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:opacity-50";

export function PropertyEquityPanel({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/accounts/manual/${accountId}/property`)
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => { if (!cancelled) setView(v); })
      .catch(() => { if (!cancelled) setView(null); });
    return () => { cancelled = true; };
  }, [accountId]);

  const act = useCallback(async (body: Record<string, string>) => {
    setBusy(true); setError(null);
    const r = await fetch(`/api/accounts/manual/${accountId}/property`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setError(data.error ?? "Could not save. Please try again."); return; }
    setView(data);
    router.refresh();
  }, [accountId, router]);

  if (!view || !view.canLinkSecuredDebt) return null;
  const eq = view.equity;
  const money = (n: number) => <span className="tabular-nums">{formatCurrencyWhole(n, eq.currency)}</span>;
  const suggested = view.candidates.find((c) => c.id === view.suggestedDebtId) ?? null;

  return (
    <div data-property-equity className="mt-4">
      <SectionLabel>Property and mortgage</SectionLabel>
      <Facts rows={[
        ["Market value", money(eq.value)],
        ...eq.securedDebts.map((d): [string, ReactNode] => [
          `${SECURED_DEBT_KIND_LABEL[d.kind]} · ${d.name}`,
          <span key={d.id} className="flex items-center gap-2">
            {money(-d.amountOwed)}
            <button type="button" className={BTN} disabled={busy} onClick={() => act({ unlink: d.id })}>Unlink</button>
          </span>,
        ]),
        ["Equity", eq.equity !== null ? money(eq.equity) : <span key="e" className="text-[var(--text-muted)]">Not available</span>],
        ["Value is", BASIS_LABEL[eq.valueBasis]],
      ]} />
      <p className="mt-2 text-xs text-[var(--text-muted)]">
        Equity is shown for reference. Net worth counts the home at its value and the mortgage as debt, so equity is never added on top.
      </p>

      {eq.doubleCount && (
        <div role="alert" data-double-count className="mt-3 rounded-[var(--radius-md)] border border-[var(--amber-400,#f5b041)] px-3 py-2.5 text-xs text-[var(--text-secondary)]">
          <p>{doubleCountDisclosure(eq.doubleCount)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={BTN} disabled={busy} onClick={() => act({ valueBasis: "MARKET_VALUE" })}>This is market value</button>
            <button type="button" className={BTN} disabled={busy} onClick={() => act({ valueBasis: "EQUITY_ENTERED" })}>This is equity</button>
          </div>
          {eq.valueBasis === "EQUITY_ENTERED" && (
            <p className="mt-2">To fix net worth, update this property&apos;s value to its market value, then mark it as market value.</p>
          )}
        </div>
      )}
      {!eq.doubleCount && eq.valueBasis === "UNKNOWN" && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
          <span>Is this value the home&apos;s market value or your equity?</span>
          <button type="button" className={BTN} disabled={busy} onClick={() => act({ valueBasis: "MARKET_VALUE" })}>Market value</button>
          <button type="button" className={BTN} disabled={busy} onClick={() => act({ valueBasis: "EQUITY_ENTERED" })}>Equity</button>
        </div>
      )}

      {suggested && (
        <div data-link-suggestion className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span>Is {suggested.name} ({SECURED_DEBT_KIND_LABEL[suggested.kind]}) the loan on this property?</span>
          <button type="button" className={BTN} disabled={busy} onClick={() => act({ link: suggested.id })}>Yes, link it</button>
        </div>
      )}
      {!suggested && view.candidates.length > 0 && (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
          Link a mortgage or HELOC
          <select
            className="rounded-[var(--radius-sm)] border border-[var(--border-hairline)] bg-transparent px-2 py-1"
            value="" disabled={busy}
            onChange={(e) => { if (e.target.value) act({ link: e.target.value }); }}
          >
            <option value="">Choose…</option>
            {view.candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {SECURED_DEBT_KIND_LABEL[c.kind]}</option>
            ))}
          </select>
        </label>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-[var(--coral-400)]">{error}</p>}
    </div>
  );
}
