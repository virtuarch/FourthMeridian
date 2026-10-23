/**
 * lib/refresh/refresh-all.ts  (P1 — provider-agnostic Refresh All: the ORCHESTRATOR)
 *
 * "Refresh All" means: refresh Fourth Meridian's understanding from EVERY
 * eligible connected financial authority. Before P1 every user refresh control
 * posted /api/plaid/refresh, so it meant "refresh Plaid" and a customer with a
 * bank and a wallet pressed Refresh and got half their money refreshed.
 *
 * ── What this composes, and what it never does ──────────────────────────────
 * It is a DECISION layer over the execution primitives that already exist —
 * `refreshAllActiveItemsForUser` (every Plaid item through the canonical
 * RefreshExecution envelope under the per-item lock) and `syncWalletByChain`
 * (every wallet through its chain adapter, ledgered the same way). It adds NO
 * second execution path, NO provider call of its own, and imports NO database
 * client: the caller hands in the reads and guard writes it is entitled to
 * (lib/refresh/deps.ts — a tenant transaction for the customer, fm_system for
 * an operator).
 *
 * ── The decision, per authority, in this order ──────────────────────────────
 *   1. admission       maintenance / ingestion pause ⇒ every authority
 *                      REFUSED NOT_ADMITTED, no clock touched, no provider call
 *   2. refreshable     a Plaid item that is not ACTIVE, a wallet on a chain
 *                      with no adapter ⇒ REFUSED NOT_REFRESHABLE
 *   3. entitlement     the customer's effective entitlements decide the manual
 *                      cooldown window (manualBankRefreshCooldownMinutes — ONE
 *                      contract for banks and wallets) and the wallet syncs per
 *                      hour (manualWalletRefreshPerHour)
 *   4. cooldown        inside the window ⇒ SKIPPED COOLDOWN with retryAfter
 *   5. rate            (wallets) the per-user hourly count ⇒ REFUSED RATE_LIMITED
 *   6. lock            another sync holds the authority ⇒ SKIPPED IN_FLIGHT
 *   7. execute         STARTED with the execution id when known; a throw or a
 *                      failed adapter ⇒ FAILED ERROR. One authority's failure
 *                      never blocks the next.
 *
 * Operators get the SAME decisions: an operator refresh on a customer's behalf
 * obeys the customer's cooldown and the platform ceilings and is told
 * COOLDOWN / IN_FLIGHT honestly — there is no `force`. Only the ledger trigger
 * differs (MANUAL for the customer, OPERATOR for an operator).
 *
 * Wallets run SEQUENTIALLY (every wallet sync leaves the one server IP for a
 * public explorer) under a wall-clock budget; whatever is not started is
 * reported, never silently dropped.
 */

import type { EffectiveEntitlements } from "@/lib/entitlements/resolve";
import type { AdmissionVerdict } from "@/lib/platform/admission/types";
import type { RefreshTrigger } from "@/lib/plaid/refresh-execution-types";
import type { RefreshSummary } from "@/lib/plaid/refresh";
import type { WalletSyncOutcome } from "@/lib/crypto/wallet-sync-dispatch";
import { checkManualRefreshCooldown, cooldownMsFromMinutes } from "@/lib/plaid/refreshCooldown";
import {
  summarizeRefreshOutcomes, type RefreshAllReport, type RefreshAuthorityOutcome, type RefreshSkipReason,
} from "./outcomes";

export interface RefreshAllRequest {
  userId: string;
  authority: "USER" | "OPERATOR";
  /** The operator acting, when authority is OPERATOR. */
  actor?: { userId: string; via: "PLATFORM_GRANT" | "SYSTEM_ADMIN" };
  /** Resolved by the caller through the client it is entitled to. */
  entitlements: EffectiveEntitlements;
  now?: Date;
}

/** A Plaid item as the caller's read client sees it. */
export interface PlaidAuthorityFact {
  id: string;
  institutionName: string;
  status: string;
  lastManualRefreshAt: Date | null;
}

/** A wallet FinancialAccount with its Connection (the lock + cooldown carrier), when it has one. */
export interface WalletAuthorityFact {
  accountId: string;
  chain: string | null;
  label: string;
  connectionId: string | null;
  lastManualRefreshAt: Date | null;
}

export interface RefreshAllDeps {
  /** Platform admission. Default: the canonical `admitOperationalWork({ work: "REFRESH_EXECUTION" })`. */
  admit?: () => Promise<Pick<AdmissionVerdict, "decision" | "reason">>;
  /** The customer's Plaid items — ALL statuses, so a non-ACTIVE item is reported, not hidden. */
  listPlaidItems: (userId: string) => Promise<PlaidAuthorityFact[]>;
  /** The customer's wallet accounts with their Connection facts. */
  listWallets: (userId: string) => Promise<WalletAuthorityFact[]>;
  /** Stamp PlaidItem.lastManualRefreshAt on every item about to be attempted. */
  markPlaidAttempts: (plaidItemIds: string[], at: Date) => Promise<void>;
  /** The Plaid fan-out. Default: `refreshAllActiveItemsForUser` with the trigger. */
  runPlaidItems?: (userId: string, excludeItemIds: string[], trigger: RefreshTrigger) => Promise<RefreshSummary>;
  /** Observe the Plaid fan-out's own summary (totals the legacy route still reports). */
  onPlaidSummary?: (summary: RefreshSummary) => void;
  /** Per-user wallet rate check against the ENTITLED limit. Consumes one slot when it allows. */
  walletRateCheck: (userId: string, limitPerHour: number) => Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
  claimWallet: (connectionId: string, at: Date) => Promise<boolean>;
  releaseWallet: (connectionId: string) => Promise<void>;
  markWalletAttempt: (connectionId: string, at: Date) => Promise<void>;
  /** Default: `syncWalletByChain(accountId, chain, { trigger })`. */
  runWallet?: (accountId: string, chain: string, trigger: RefreshTrigger) => Promise<WalletSyncOutcome>;
  /** Default: `finalizeWalletSync` (today's snapshots + planned history). */
  afterWallet?: (accountId: string, chain: string, outcome: WalletSyncOutcome, startedAt: Date) => Promise<void>;
  /** Default: the dispatch registry's `isSyncableChain`. */
  isSyncableChain?: (chain: string | null) => boolean;
  /** Wall-clock budget for the sequential wallet pass. */
  budgetMs?: number;
  now?: () => Date;
}

/** Default budget: the scheduled sweep's figure (lib/crypto/wallet-refresh.ts). */
export const REFRESH_ALL_WALLET_BUDGET_MS = 90_000;

/**
 * Not yet in the shared vocabulary (lib/refresh/outcomes.ts is coordinator-owned):
 * a wallet that was not STARTED because the wall-clock budget ran out. Proposed
 * as `"BUDGET"` on `RefreshSkipReason`; until then it is typed through the union.
 */
const BUDGET_REASON = "BUDGET" as unknown as RefreshSkipReason;

/** Whether the effective entitlements permit a manual refresh at all. One place, so a future
 *  boolean dimension (e.g. `manualRefresh`) is honoured everywhere by editing this alone. */
export function isManualRefreshEntitled(_e: EffectiveEntitlements): boolean {
  return true;
}

function triggerFor(authority: RefreshAllRequest["authority"]): RefreshTrigger {
  return authority === "OPERATOR" ? "OPERATOR" : "MANUAL";
}

async function defaultAdmit() {
  const { admitOperationalWork } = await import("@/lib/platform/admission/facts");
  return admitOperationalWork({ work: "REFRESH_EXECUTION" });
}
async function defaultRunPlaidItems(userId: string, excludeItemIds: string[], trigger: RefreshTrigger) {
  const { refreshAllActiveItemsForUser } = await import("@/lib/plaid/refresh");
  return refreshAllActiveItemsForUser(userId, { excludeItemIds }, { trigger });
}
async function defaultRunWallet(accountId: string, chain: string, trigger: RefreshTrigger) {
  const { syncWalletByChain } = await import("@/lib/crypto/wallet-sync-dispatch");
  return syncWalletByChain(accountId, chain, { trigger });
}
async function defaultAfterWallet(accountId: string, chain: string, outcome: WalletSyncOutcome, startedAt: Date) {
  const { finalizeWalletSync } = await import("./wallet-post-sync");
  return finalizeWalletSync({ accountId, chain, outcome, syncStartedAt: startedAt, logPrefix: "[refresh-all]" });
}
async function defaultIsSyncable(chain: string | null) {
  const { isSyncableChain } = await import("@/lib/crypto/wallet-sync-dispatch");
  return isSyncableChain(chain);
}

export async function refreshAllForUser(req: RefreshAllRequest, deps: RefreshAllDeps): Promise<RefreshAllReport> {
  const now = deps.now ?? (() => req.now ?? new Date());
  const startedAt = now();
  const trigger = triggerFor(req.authority);
  const cooldownMs = cooldownMsFromMinutes(Number(req.entitlements.dimensions.manualBankRefreshCooldownMinutes.value));
  const walletsPerHour = Number(req.entitlements.dimensions.manualWalletRefreshPerHour.value);
  const budgetMs = deps.budgetMs ?? REFRESH_ALL_WALLET_BUDGET_MS;
  const isSyncable = deps.isSyncableChain ?? defaultIsSyncable;

  const [plaidItems, wallets] = await Promise.all([deps.listPlaidItems(req.userId), deps.listWallets(req.userId)]);
  const outcomes: RefreshAuthorityOutcome[] = [];

  // ── 1. admission ──────────────────────────────────────────────────────────
  const admission = await (deps.admit ?? defaultAdmit)();
  if (admission.decision === "DENY") {
    for (const it of plaidItems) outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "REFUSED", reason: "NOT_ADMITTED" });
    for (const w of wallets) outcomes.push({ kind: "WALLET", id: w.accountId, label: w.label, decision: "REFUSED", reason: "NOT_ADMITTED" });
    return report(req, startedAt, outcomes);
  }

  const entitled = isManualRefreshEntitled(req.entitlements);

  // ── Plaid: decide every item, then ONE fan-out over the eligible set ───────
  const eligible: PlaidAuthorityFact[] = [];
  const excluded: string[] = [];
  for (const it of plaidItems) {
    if (it.status !== "ACTIVE") {
      outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: `${it.institutionName} (${it.status})`, decision: "REFUSED", reason: "NOT_REFRESHABLE" });
      excluded.push(it.id); continue;
    }
    if (!entitled) {
      outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "REFUSED", reason: "NOT_ENTITLED", entitlement: "manualBankRefreshCooldownMinutes" });
      excluded.push(it.id); continue;
    }
    const cd = checkManualRefreshCooldown(it.lastManualRefreshAt, cooldownMs, startedAt.getTime());
    if (cd.onCooldown) {
      outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "SKIPPED", reason: "COOLDOWN",
        retryAfterSeconds: cd.retryAfterSeconds, entitlement: "manualBankRefreshCooldownMinutes" });
      excluded.push(it.id); continue;
    }
    eligible.push(it);
  }
  if (eligible.length > 0) {
    // Every attempt counts (success or failure) — the Plaid route's rule since D2 Step 7B.
    await deps.markPlaidAttempts(eligible.map((i) => i.id), startedAt);
    let summary: RefreshSummary | null = null;
    try {
      summary = await (deps.runPlaidItems ?? defaultRunPlaidItems)(req.userId, excluded, trigger);
      deps.onPlaidSummary?.(summary);
    } catch (e) {
      console.error("[refresh-all] plaid fan-out threw (outcomes recorded as FAILED):", e instanceof Error ? e.message : String(e));
    }
    const byId = new Map((summary?.results ?? []).map((r) => [r.plaidItemId, r] as const));
    for (const it of eligible) {
      const r = byId.get(it.id);
      if (!r) {
        // The fan-out skipped it before the envelope: no live linked account (self-healed).
        outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: summary ? "REFUSED" : "FAILED", reason: summary ? "NOT_REFRESHABLE" : "ERROR" });
      } else if (r.skipped === "in-flight") {
        outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "SKIPPED", reason: "IN_FLIGHT" });
      } else if (r.ok) {
        outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "STARTED", reason: null, executionId: r.executionId ?? null });
      } else {
        outcomes.push({ kind: "PLAID_ITEM", id: it.id, label: it.institutionName, decision: "FAILED", reason: "ERROR", executionId: r.executionId ?? null });
      }
    }
  }

  // ── Wallets: sequential, budgeted ──────────────────────────────────────────
  for (const w of wallets) {
    const label = w.label;
    if (!(await isSyncable(w.chain))) {
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "REFUSED", reason: "NOT_REFRESHABLE" }); continue;
    }
    if (!entitled) {
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "REFUSED", reason: "NOT_ENTITLED", entitlement: "manualBankRefreshCooldownMinutes" }); continue;
    }
    if (now().getTime() - startedAt.getTime() > budgetMs) {
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "SKIPPED", reason: BUDGET_REASON }); continue;
    }
    const cd = checkManualRefreshCooldown(w.lastManualRefreshAt, cooldownMs, now().getTime());
    if (cd.onCooldown) {
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "SKIPPED", reason: "COOLDOWN",
        retryAfterSeconds: cd.retryAfterSeconds, entitlement: "manualBankRefreshCooldownMinutes" }); continue;
    }
    const rate = await deps.walletRateCheck(req.userId, walletsPerHour);
    if (!rate.allowed) {
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "REFUSED", reason: "RATE_LIMITED",
        retryAfterSeconds: rate.retryAfterSeconds, entitlement: "manualWalletRefreshPerHour" }); continue;
    }
    const at = now();
    let claimed = false;
    if (w.connectionId) {
      claimed = await deps.claimWallet(w.connectionId, at);
      if (!claimed) { outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "SKIPPED", reason: "IN_FLIGHT" }); continue; }
      await deps.markWalletAttempt(w.connectionId, at);
    }
    try {
      const outcome = await (deps.runWallet ?? defaultRunWallet)(w.accountId, w.chain as string, trigger);
      if (outcome.support === "UNSUPPORTED") {
        outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "REFUSED", reason: "NOT_REFRESHABLE" });
      } else if (outcome.ok) {
        await (deps.afterWallet ?? defaultAfterWallet)(w.accountId, w.chain as string, outcome, at).catch(() => undefined);
        outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "STARTED", reason: null });
      } else {
        outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "FAILED", reason: "ERROR" });
      }
    } catch (e) {
      console.error(`[refresh-all] wallet ${w.accountId} threw:`, e instanceof Error ? e.message : String(e));
      outcomes.push({ kind: "WALLET", id: w.accountId, label, decision: "FAILED", reason: "ERROR" });
    } finally {
      if (claimed && w.connectionId) await deps.releaseWallet(w.connectionId);
    }
  }

  return report(req, startedAt, outcomes);
}

function report(req: RefreshAllRequest, startedAt: Date, outcomes: RefreshAuthorityOutcome[]): RefreshAllReport {
  return {
    authority: req.authority,
    userId: req.userId,
    startedAtISO: startedAt.toISOString(),
    outcomes,
    summary: summarizeRefreshOutcomes(outcomes),
  };
}
