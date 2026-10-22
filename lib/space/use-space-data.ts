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
 *
 * UI-006 — a FAILED read is never an empty one. Every structural read (sections +
 * accounts, snapshots, transactions) goes through `settleSpaceRead`, which returns
 * an explicit outcome; the `next*State` reducers below keep the previous value and
 * record a `SpaceReadError` on failure instead of coercing a 401/403/500 or a
 * network error to `[]` (which used to render "No wealth history yet" during an
 * outage). Consumers read `readErrors` and offer `retryRead(key)`.
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

// ── UI-006 — explicit read outcomes (pure; exported for the test) ─────────────

/** The three shared reads whose failure a workspace must be able to say out loud. */
export type SpaceReadKey = "structure" | "snapshots" | "transactions";

export interface SpaceReadError {
  /** HTTP status, or null when the request never completed (network / parse). */
  status:  number | null;
  /** A customer-facing sentence — never a raw loader message. */
  message: string;
}

export type SpaceReadErrors = Partial<Record<SpaceReadKey, SpaceReadError>>;

export type SpaceReadOutcome<T> =
  | { ok: true;  data: T }
  | { ok: false; error: SpaceReadError };

/** Status → the sentence a workspace shows. Pure. */
export function spaceReadError(status: number | null): SpaceReadError {
  const message =
    status === null ? "Couldn't reach Fourth Meridian. Check your connection and try again."
    : status === 401 ? "Your session has expired. Sign in again to load this Space."
    : status === 403 ? "You don't have access to this Space's data right now."
    : status === 404 ? "This Space's data couldn't be found."
    : status === 429 ? "Too many requests. Wait a moment and try again."
    : `Couldn't load this Space's data (error ${status}). This is on our side, not a sign your data is gone.`;
  return { status, message };
}

/**
 * Settle one fetch into an explicit outcome. A non-2xx response, a network
 * failure, and an unparseable body are all FAILURES — none of them is data.
 */
export async function settleSpaceRead<T>(request: Promise<Response>): Promise<SpaceReadOutcome<T>> {
  let res: Response;
  try {
    res = await request;
  } catch {
    return { ok: false, error: spaceReadError(null) };
  }
  if (!res.ok) return { ok: false, error: spaceReadError(res.status) };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: spaceReadError(res.status) };
  }
}

/** Snapshot read → next state. A failure KEEPS what was there (null stays null). */
export function nextSnapshotState(
  prev: Snapshot[] | null,
  outcome: SpaceReadOutcome<{ snapshots?: Snapshot[]; backfillInProgress?: boolean } | null>,
): { snapshots: Snapshot[] | null; backfilling: boolean; error: SpaceReadError | null } {
  if (!outcome.ok) return { snapshots: prev, backfilling: false, error: outcome.error };
  return {
    snapshots:   outcome.data?.snapshots ?? [],
    backfilling: !!outcome.data?.backfillInProgress,
    error:       null,
  };
}

/** The /transactions payload fields this hook reads. */
export type SpaceTransactionsPayload = {
  transactions?: Transaction[];
  moneyCtx?: SerializedConversionContext;
  truncated?: boolean;
  limit?: number;
} | null;

/** Transaction read → next state. A failure KEEPS what was there (null stays null). */
export function nextTransactionsState(
  prev: Transaction[] | null,
  outcome: SpaceReadOutcome<SpaceTransactionsPayload>,
): {
  transactions: Transaction[] | null;
  meta: TransactionsCoverage | null;
  moneyCtx: SerializedConversionContext | undefined;
  error: SpaceReadError | null;
} {
  if (!outcome.ok) return { transactions: prev, meta: null, moneyCtx: undefined, error: outcome.error };
  return {
    transactions: outcome.data?.transactions ?? [],
    meta:         { truncated: !!outcome.data?.truncated, limit: outcome.data?.limit },
    moneyCtx:     outcome.data?.moneyCtx ?? undefined,
    error:        null,
  };
}

/** Sections + accounts (one combined read) → next state. Either failing fails both. */
export function nextStructureState(
  prev: { sections: DashboardSection[]; accounts: SpaceAccount[] },
  sections: SpaceReadOutcome<DashboardSection[]>,
  accounts: SpaceReadOutcome<SpaceAccount[]>,
): { sections: DashboardSection[]; accounts: SpaceAccount[]; error: SpaceReadError | null } {
  if (!sections.ok) return { ...prev, error: sections.error };
  if (!accounts.ok) return { ...prev, error: accounts.error };
  return { sections: sections.data, accounts: accounts.data, error: null };
}

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
  /**
   * PS-6B — server-hydrated initial STRUCTURAL data for this Space's first
   * render, composed once at the /dashboard RSC boundary
   * (lib/space/mount-composition.ts) from the already-authorized SpaceContext.
   * When present, the three EAGER initial fetches (sections + accounts combined,
   * and the member count) are skipped — their values come from the server, and
   * `loading` starts false. Every refresh/reload path (currency change, manual
   * Plaid sync, ManageSpaceModal, shared-account change) is UNCHANGED, so the
   * data still re-fetches on those events. Absent ⇒ the client fetches on mount
   * exactly as before (shared Spaces / any non-hydrated caller). The host remounts
   * the hook on a Space switch (key={spaceId}), so the hydrated value always
   * matches the mounted spaceId.
   */
  initial?: {
    sections:    DashboardSection[];
    accounts:    SpaceAccount[];
    memberCount: number;
  } | null;
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
  /**
   * UI-006 — the reads that FAILED, by key. Absent key ⇒ that read is fine (or
   * has not run). A failed read keeps its previous value (snapshots/transactions
   * stay null on a first-load failure) — never an empty list.
   */
  readErrors: SpaceReadErrors;
  /** UI-006 — re-run one failed read. */
  retryRead:  (key: SpaceReadKey) => void;
}

export function useSpaceData({
  spaceId,
  displayCurrency,
  wantSnapshots,
  wantTransactions,
  initial,
}: UseSpaceDataArgs): SpaceData {
  // PS-6B — seed the eager structural state from the server-hydrated payload when
  // present; otherwise start empty + loading (the pre-6B behavior). `hydrated` is
  // stable for the hook's mounted life (the host remounts on a Space switch), so
  // it cleanly gates the initial fetches without racing a Space change.
  const hydrated = initial != null;
  const [sections,     setSections]     = useState<DashboardSection[]>(initial?.sections ?? []);
  const [accounts,     setAccounts]     = useState<SpaceAccount[]>(initial?.accounts ?? []);
  const [loading,      setLoading]      = useState(!hydrated);
  const [memberCount,  setMemberCount]  = useState<number | null>(initial?.memberCount ?? null);
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
  // UI-006 — failed reads + their retry nonces.
  const [readErrors, setReadErrors] = useState<SpaceReadErrors>({});
  const [snapshotRetry, setSnapshotRetry] = useState(0);
  const [txRetry,       setTxRetry]       = useState(0);
  const [structureRetry, setStructureRetry] = useState(0);
  const setReadError = useCallback((key: SpaceReadKey, error: SpaceReadError | null) => {
    setReadErrors((prev) => {
      if (!error && !prev[key]) return prev;
      const next = { ...prev };
      if (error) next[key] = error; else delete next[key];
      return next;
    });
  }, []);

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
  // UI-006 — a failed reload keeps the current list and records the failure.
  const reloadSections = useCallback(async () => {
    const out = await settleSpaceRead<DashboardSection[]>(fetch(`/api/spaces/${spaceId}/sections`));
    if (out.ok) { setSections(out.data); setReadError("structure", null); }
    else setReadError("structure", out.error);
  }, [spaceId, setReadError]);
  const reloadAccounts = useCallback(async () => {
    const out = await settleSpaceRead<SpaceAccount[]>(fetch(`/api/spaces/${spaceId}/accounts`));
    if (out.ok) { setAccounts(out.data); setReadError("structure", null); }
    else setReadError("structure", out.error);
  }, [spaceId, setReadError]);

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
  // PS-6B — skipped when hydrated (server composed the ACTIVE member count), so
  // the mount no longer calls the heavy /api/spaces/[id] route just for a length.
  useEffect(() => {
    if (hydrated) return;
    let active = true;
    fetch(`/api/spaces/${spaceId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (active) setMemberCount(data?.members?.length ?? null); })
      .catch(() => { if (active) setMemberCount(null); });
    return () => { active = false; };
  }, [spaceId, hydrated]);

  // ── Snapshot history (+ backfill flag) ──────────────────────────────────────
  useEffect(() => {
    if (!wantSnapshots) return;
    let active = true;
    // UI-006 — a failed read is recorded, never coerced to `{ snapshots: [] }`.
    settleSpaceRead<{ snapshots?: Snapshot[]; backfillInProgress?: boolean } | null>(
      fetch(`/api/spaces/${spaceId}/snapshots`),
    ).then((outcome) => {
      if (!active) return;
      // On failure `next.snapshots` is the prev we pass (null) and is NOT applied:
      // the current value stays, the failure is recorded.
      const next = nextSnapshotState(null, outcome);
      setReadError("snapshots", next.error);
      setBackfilling(next.backfilling); // Part-6
      if (!next.error) setSnapshots(next.snapshots);
    });
    return () => { active = false; };
  }, [spaceId, wantSnapshots, currencyNonce, refreshNonce, snapshotRetry, setReadError]);

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
    // UI-006 — a failed read is recorded and `transactions` STAYS null (the guard
    // above then lets `retryRead("transactions")` re-run it); never `[]`.
    settleSpaceRead<SpaceTransactionsPayload>(
      fetch(`/api/spaces/${spaceId}/transactions`),
    ).then((outcome) => {
      if (!active) return;
      const next = nextTransactionsState(null, outcome);
      setReadError("transactions", next.error);
      if (next.error) return;
      setTransactions(next.transactions);
      setMoneyCtx(next.moneyCtx); // MC1 P4 Slice 6 (F-6)
      // TX-2A — carry the coverage sentinel so workspaces can be honest when the
      // read was capped (TX-2). Absent/false ⇒ complete ⇒ no indicator.
      setTransactionsMeta(next.meta);
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId, wantTransactions, transactions === null, currencyNonce, refreshNonce, txRetry]);

  // ── Initial sections + accounts (one combined fetch; flips `loading` false) ──
  // PS-6B — skipped when hydrated: the server composition already provided both
  // (and `loading` started false). Refresh still works — reloadSections /
  // reloadAccounts and the event listeners above re-fetch on demand, unchanged.
  useEffect(() => {
    // A hydrated mount skips the FIRST read only; a retry always runs.
    if (hydrated && structureRetry === 0) return;
    let active = true;
    // UI-006 — either read failing is a recorded failure (the lists stay as they
    // were), never `[]` presented as "this Space has no accounts".
    Promise.all([
      settleSpaceRead<DashboardSection[]>(fetch(`/api/spaces/${spaceId}/sections`)),
      settleSpaceRead<SpaceAccount[]>(fetch(`/api/spaces/${spaceId}/accounts`)),
    ]).then(([secs, accs]) => {
      if (!active) return;
      const next = nextStructureState({ sections: [], accounts: [] }, secs, accs); // prev unused: not applied on failure
      setReadError("structure", next.error);
      if (!next.error) {
        setSections(next.sections);
        setAccounts(next.accounts);
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [spaceId, hydrated, structureRetry, setReadError]);

  // UI-006 — re-run one failed read.
  const retryRead = useCallback((key: SpaceReadKey) => {
    if (key === "structure") setStructureRetry((n) => n + 1);
    else if (key === "snapshots") setSnapshotRetry((n) => n + 1);
    else setTxRetry((n) => n + 1);
  }, []);

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
    readErrors,
    retryRead,
  };
}
