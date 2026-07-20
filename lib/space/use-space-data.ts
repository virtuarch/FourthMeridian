"use client";

/**
 * lib/space/use-space-data.ts  (SD-7b)
 *
 * The Space's shared STRUCTURAL data lifecycle — extracted verbatim from
 * SpaceDashboard. This owns every client fetch the host used to run for the data
 * that is shared across workspaces (sections, accounts, snapshots, transactions,
 * the view/widget conversion context, member count) PLUS the refresh
 * orchestration that kept them fresh (the currency-change / manual-Plaid-sync /
 * shared-account-change event listeners and their re-fetch nonces, and the
 * snapshot backfill poll).
 *
 * It is deliberately BORING — a straight relocation of the host's effects, not a
 * rewrite: same endpoints, same guards, same fetch shapes, same nonce mechanics.
 * The host now CONSUMES this data; it no longer owns the lifecycle.
 *
 * NAVIGATION stays out: the host folds its nav-derived lazy-activation gates into
 * two plain booleans (`wantSnapshots` / `wantTransactions`) so this hook never
 * sees the active tab or perspective. Perspective-engine results (lensResults)
 * are a PERSPECTIVE loader and remain host-owned — not part of this extraction.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { rehydrateContext, type SerializedConversionContext } from "@/lib/money/convert";
import {
  SPACE_ACCOUNTS_CHANGED_EVENT,
  SPACE_CURRENCY_CHANGED_EVENT,
  SPACE_DATA_REFRESHED_EVENT,
} from "@/lib/space-nav";
import type { DashboardSection, SpaceAccount } from "@/lib/space/dashboard-types";
import type { ConversionContext } from "@/lib/money/types";
import type { TransactionsCoverage } from "@/lib/transactions/coverage-note";
import type { Snapshot, Transaction } from "@/types";

export interface UseSpaceDataArgs {
  spaceId: string;
  /** The Space's display currency (the /view-context target; re-fetches on change). */
  displayCurrency: string;
  /**
   * Whether a snapshot-tier surface is engaged. The host folds its gate
   * (heroDef || PERSONAL || perspectiveNeedsSnapshots) into this so the hook stays
   * nav-agnostic. false ⇒ snapshots stay null (lazy, exactly as before).
   */
  wantSnapshots: boolean;
  /**
   * Whether a transactions-tier surface is engaged. The host folds its gate
   * (isFlowCategory || Transactions tab || perspectiveNeedsTransactions) into this.
   * false ⇒ transactions stay null (lazy, exactly as before).
   */
  wantTransactions: boolean;
}

export interface SpaceData {
  sections:     DashboardSection[];
  accounts:     SpaceAccount[];
  loading:      boolean;
  snapshots:    Snapshot[] | null;
  backfilling:  boolean;
  transactions: Transaction[] | null;
  /**
   * TX-2A — the transaction population's coverage state. `truncated` is true when
   * the server capped the read to the most-recent `limit` rows (TX-2 boundary), so
   * a workspace can be HONEST that its history is incomplete instead of silently
   * appearing complete. null until the transaction fetch resolves; workspace-safe
   * (no raw loader vocabulary rides up here).
   */
  transactionsMeta: TransactionsCoverage | null;
  moneyCtx:     SerializedConversionContext | undefined;
  widgetCtx:    ConversionContext | undefined;
  memberCount:  number | null;
  /**
   * V25-CLOSE-3A — the reporting-currency failure verdict for the active display
   * currency, from the shared /view-context decision. `reverted` is true when the
   * requested currency could not be satisfied and the display fell back to
   * `effectiveCurrency` (USD). Undefined `effectiveCurrency` until the fetch
   * resolves. The stored Space.reportingCurrency is never changed by this.
   */
  currencyReverted:  boolean;
  requestedCurrency: string | undefined;
  effectiveCurrency: string | undefined;
  /** Re-fetch sections / accounts (ManageSpaceModal's onRefresh). */
  reloadSections: () => Promise<void>;
  reloadAccounts: () => Promise<void>;
}

export function useSpaceData({
  spaceId,
  displayCurrency,
  wantSnapshots,
  wantTransactions,
}: UseSpaceDataArgs): SpaceData {
  const [sections,     setSections]     = useState<DashboardSection[]>([]);
  const [accounts,     setAccounts]     = useState<SpaceAccount[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [memberCount,  setMemberCount]  = useState<number | null>(null);
  const [snapshots,    setSnapshots]    = useState<Snapshot[] | null>(null);
  const [backfilling,  setBackfilling]  = useState(false);
  const [transactions, setTransactions] = useState<Transaction[] | null>(null);
  const [transactionsMeta, setTransactionsMeta] = useState<TransactionsCoverage | null>(null);
  const [moneyCtx,     setMoneyCtx]     = useState<SerializedConversionContext | undefined>(undefined);
  const [widgetMoneyCtx, setWidgetMoneyCtx] = useState<SerializedConversionContext | undefined>(undefined);
  // V25-CLOSE-3A — reporting-currency failure verdict from /view-context.
  const [currencyReverted,  setCurrencyReverted]  = useState(false);
  const [requestedCurrency, setRequestedCurrency] = useState<string | undefined>(undefined);
  const [effectiveCurrency, setEffectiveCurrency] = useState<string | undefined>(undefined);

  // MC1 QA Q6 — a reporting-currency change re-runs the currency-keyed fetches
  // (snapshots + transactions). All-USD: the event never fires, so nothing here
  // ever runs. Part-2 — a manual Plaid sync (SPACE_DATA_REFRESHED_EVENT) re-runs
  // accounts + snapshots + transactions (router.refresh() can't re-run these
  // client effects). Both are explicit re-fetch nonces.
  const [currencyNonce, setCurrencyNonce] = useState(0);
  const [refreshNonce,  setRefreshNonce]  = useState(0);

  // ── View/widget conversion context — follows the display currency ───────────
  useEffect(() => {
    let active = true;
    fetch(`/api/money/view-context?target=${encodeURIComponent(displayCurrency)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!active) return;
        setWidgetMoneyCtx(data?.moneyCtx ?? undefined);
        // V25-CLOSE-3A — carry the failure verdict to the composition root.
        setCurrencyReverted(!!data?.reverted);
        setRequestedCurrency(data?.requested ?? undefined);
        setEffectiveCurrency(data?.effective ?? undefined);
      })
      .catch(() => {
        if (!active) return;
        setWidgetMoneyCtx(undefined);
        setCurrencyReverted(false);
        setRequestedCurrency(undefined);
        setEffectiveCurrency(undefined);
      });
    return () => { active = false; };
  }, [displayCurrency]);
  const widgetCtx = useMemo(
    () => (widgetMoneyCtx ? rehydrateContext(widgetMoneyCtx) : undefined),
    [widgetMoneyCtx],
  );

  // ── Reload helpers (ManageSpaceModal refresh + the event listeners below) ────
  const reloadSections = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/sections`);
    if (res.ok) setSections(await res.json());
  }, [spaceId]);
  const reloadAccounts = useCallback(async () => {
    const res = await fetch(`/api/spaces/${spaceId}/accounts`);
    if (res.ok) setAccounts(await res.json());
  }, [spaceId]);

  // ── Refresh orchestration — the event listeners + nonces ────────────────────
  useEffect(() => {
    function onCurrencyChanged(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      // Ignore currency changes for other Spaces (e.g. edited from the Spaces list).
      if (detail?.spaceId && detail.spaceId !== spaceId) return;
      setTransactions(null);   // release the tx fetch's "already loaded" guard
      setTransactionsMeta(null); // TX-2A — re-derived by the refetch
      setMoneyCtx(undefined);
      setCurrencyNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
    return () => window.removeEventListener(SPACE_CURRENCY_CHANGED_EVENT, onCurrencyChanged);
  }, [spaceId]);

  useEffect(() => {
    function handleAccountsChanged() { reloadAccounts(); }
    window.addEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
    return () => window.removeEventListener(SPACE_ACCOUNTS_CHANGED_EVENT, handleAccountsChanged);
  }, [reloadAccounts]);

  useEffect(() => {
    function onDataRefreshed(e: Event) {
      const detail = (e as CustomEvent<{ spaceId?: string }>).detail;
      if (detail?.spaceId && detail.spaceId !== spaceId) return; // ignore other Spaces
      reloadAccounts();
      setTransactions(null);
      setTransactionsMeta(null); // TX-2A — re-derived by the refetch
      setRefreshNonce((n) => n + 1);
    }
    window.addEventListener(SPACE_DATA_REFRESHED_EVENT, onDataRefreshed);
    return () => window.removeEventListener(SPACE_DATA_REFRESHED_EVENT, onDataRefreshed);
  }, [spaceId, reloadAccounts]);

  // ── Header member count ─────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    fetch(`/api/spaces/${spaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMemberCount(data?.members?.length ?? null); })
      .catch(() => { if (active) setMemberCount(null); });
    return () => { active = false; };
  }, [spaceId]);

  // ── Snapshot history (+ backfill flag) ──────────────────────────────────────
  useEffect(() => {
    if (!wantSnapshots) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}/snapshots`)
      .then((r) => (r.ok ? r.json() : { snapshots: [] }))
      .then((data) => {
        if (!active) return;
        setSnapshots(data?.snapshots ?? []);
        setBackfilling(!!data?.backfillInProgress); // Part-6
      })
      .catch(() => { if (active) { setSnapshots([]); setBackfilling(false); } });
    return () => { active = false; };
  }, [spaceId, wantSnapshots, currencyNonce, refreshNonce]);

  // Part-6 — while a backfill runs, re-fetch snapshots on an interval so the
  // Wealth loading state clears automatically once it finishes. Bumping
  // refreshNonce re-runs the snapshot fetch, which updates `backfilling`; when it
  // flips false this effect stops.
  useEffect(() => {
    if (!backfilling) return;
    const iv = setInterval(() => setRefreshNonce((n) => n + 1), 12000);
    return () => clearInterval(iv);
  }, [backfilling]);

  // ── Space transactions (KD-15-filtered on the server) + F-6 money context ───
  useEffect(() => {
    if (!wantTransactions) return;
    if (transactions !== null) return; // runs once until cleared by a refresh nonce
    let active = true;
    fetch(`/api/spaces/${spaceId}/transactions`)
      .then((r) => (r.ok ? r.json() : { transactions: [] }))
      .then((data) => {
        if (!active) return;
        setTransactions(data?.transactions ?? []);
        setMoneyCtx(data?.moneyCtx ?? undefined); // MC1 P4 Slice 6 (F-6)
        // TX-2A — carry the coverage sentinel so workspaces can be honest when the
        // read was capped (TX-2). Absent/false ⇒ complete ⇒ no indicator.
        setTransactionsMeta({ truncated: !!data?.truncated, limit: data?.limit });
      })
      .catch(() => { if (active) { setTransactions([]); setTransactionsMeta(null); } });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, wantTransactions, transactions === null, currencyNonce, refreshNonce]);

  // ── Initial sections + accounts (one combined fetch; flips `loading` false) ──
  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`/api/spaces/${spaceId}/sections`).then((r) => (r.ok ? r.json() : [])),
      fetch(`/api/spaces/${spaceId}/accounts`).then((r)  => (r.ok ? r.json() : [])),
    ]).then(([secs, accs]: [DashboardSection[], SpaceAccount[]]) => {
      if (!active) return;
      setSections(secs);
      setAccounts(accs);
      setLoading(false);
    });
    return () => { active = false; };
  }, [spaceId]);

  return {
    sections,
    accounts,
    loading,
    snapshots,
    backfilling,
    transactions,
    transactionsMeta,
    moneyCtx,
    widgetCtx,
    memberCount,
    currencyReverted,
    requestedCurrency,
    effectiveCurrency,
    reloadSections,
    reloadAccounts,
  };
}
