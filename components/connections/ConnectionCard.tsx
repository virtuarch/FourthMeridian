"use client";

/**
 * components/connections/ConnectionCard.tsx
 *
 * D2.x — the canonical Connections product unit. ONE card design for every
 * provider/institution. Importing / ready / needs_reauth / error are state
 * transitions of the SAME card, not different cards: the visual shell
 * (Liquid/Glass, hierarchy, spacing, typography) is constant; only the inner
 * content evolves (Building → Connected → Synced → Needs Attention). The card
 * feels like it matures over time rather than being replaced.
 *
 * Shell:
 *   - AtlasLiquidCard (Daily-Brief Liquid material) when Liquid is allowed —
 *     useAtlasLiquid() capability gate AND within the list's Liquid cap.
 *   - DataCard (Atlas Glass) fallback otherwise — same card family.
 *
 * Connections is a provider-management surface, NOT the Accounts page:
 *   - Provider is part of identity ("Synced via Plaid"), via providerName().
 *   - Account NAMES only — never dollar balances (those live on
 *     Accounts/Spaces/Dashboard).
 *
 * Reuses existing Atlas primitives only. No new material, no new primitive.
 * Presentational; live state comes from the parent ConnectionsList poller.
 */

import {
  CheckCircle2,
  Circle,
  Loader2,
  Building2,
  AlertTriangle,
  Info,
} from "lucide-react";
import { DataCard } from "@/components/atlas/DataCard";
import { AtlasLiquidCard } from "@/components/atlas/AtlasLiquidCard";
import { useAtlasLiquid } from "@/components/atlas/useAtlasLiquid";
import { ReconnectAccountButton } from "@/components/dashboard/ReconnectAccountButton";
import { EnableInvestmentsButton } from "@/components/dashboard/EnableInvestmentsButton";
import { SyncWalletButton } from "@/components/dashboard/SyncWalletButton";
import { ImportHistoryButton } from "@/components/connections/import/ImportHistoryButton";
import { providerName, type SyncConnection } from "@/lib/sync/status";
import { deriveConnectionLifecycle } from "@/lib/sync/lifecycle";
import {
  formatAvailableHistory,
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";
import { ConnectionTimeline } from "@/components/connections/ConnectionTimeline";
import { ConnectionMenu } from "@/components/connections/ConnectionMenu";

/** Account inventory item — NAMES ONLY on Connections (no balances). */
export interface AccountLite {
  id:   string;
  name: string;
  type: string;
}

interface Props {
  connection: SyncConnection;
  accounts:   AccountLite[];
  /** CONN-2A — derived intelligence status for this connection. When absent the
   *  card falls back to the pre-CONN-2 state-only rendering. */
  intelligence?: ConnectionIntelligenceStatus;
  /** True after the poll safety cap: importing is taking longer than usual. */
  slow?:      boolean;
  /**
   * Whether this card is permitted to use the Liquid material (the list caps
   * the number of Liquid cards for WebGL-context safety). Combined with the
   * useAtlasLiquid() capability gate below. Default true.
   */
  allowLiquid?: boolean;
}

// ── Honest stage stepper (importing) ──────────────────────────────────────────
// Each node is a real, observable state — no interpolation, no invented %.

type StageStatus = "done" | "active" | "pending";
interface Stage {
  label:  string;
  value?: string;
  status: StageStatus;
}

function StageStepper({ stages }: { stages: Stage[] }) {
  return (
    <ol className="relative mt-1">
      {stages.map((s, i) => {
        const isLast = i === stages.length - 1;
        return (
          <li key={s.label} className="relative flex items-start gap-3 pb-3 last:pb-0">
            {!isLast && (
              <span
                aria-hidden
                className="absolute left-[8px] top-5 bottom-0 w-px"
                style={{
                  background:
                    s.status === "done"
                      ? "var(--accent-positive, #34d399)"
                      : "var(--border-hairline)",
                }}
              />
            )}
            <span className="relative z-10 mt-0.5 shrink-0">
              {s.status === "done" && (
                <CheckCircle2 size={17} className="text-[var(--accent-positive,#34d399)]" />
              )}
              {s.status === "active" && (
                <Loader2 size={17} className="animate-spin text-[var(--meridian-400)]" />
              )}
              {s.status === "pending" && (
                <Circle size={17} className="text-[var(--text-muted)] opacity-60" />
              )}
            </span>
            <div className="min-w-0 pt-px">
              <span
                className={
                  s.status === "pending"
                    ? "text-sm text-[var(--text-muted)]"
                    : "text-sm text-[var(--text-primary)]"
                }
              >
                {s.label}
              </span>
              {s.value && <span className="text-sm text-[var(--text-muted)]"> · {s.value}</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** A completed, honest status row (ready state). */
function DoneStatusRow({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      <CheckCircle2 size={15} className="text-[var(--accent-positive,#34d399)] shrink-0" />
      <span>{label}</span>
    </li>
  );
}

/**
 * Investments capability affordance for a Plaid connection.
 *   "enabled"   → honest "Investments synced" done-row (holdings active).
 *   "available" → "Enable Investments" action (update-mode consent) for THIS
 *                 Item. Only shown where the connection plausibly supports
 *                 investment data (CONSENT_REQUIRED) — never for unsupported /
 *                 unknown connections, so it can't mislead.
 *   null        → nothing.
 * Plaid-only: wallets always carry investments=null.
 */
function InvestmentsCapability({ connection }: { connection: SyncConnection }) {
  if (connection.provider !== "PLAID") return null;

  if (connection.investments === "enabled") {
    return (
      <ul className="mt-3 space-y-1.5">
        <DoneStatusRow label="Investments synced" />
      </ul>
    );
  }

  if (connection.investments === "available") {
    return (
      <div className="mt-3 flex flex-col gap-1.5">
        <span className="text-sm text-[var(--text-muted)]">Investment holdings available for this connection.</span>
        <EnableInvestmentsButton plaidItemId={connection.id} />
      </div>
    );
  }

  return null;
}

// ── Shared content fragments (identical across Liquid + Glass) ─────────────────

/**
 * Provider-aware sub-line. Provider is part of the connection's identity.
 *   importing → "Connected via Plaid"
 *   ready     → "Synced via Plaid"
 *   needs_reauth / error → "Previously synced via Plaid"
 */
function providerLine(connection: SyncConnection): string {
  const name = providerName(connection.provider);
  switch (connection.state) {
    case "importing":
      return `Connected via ${name}`;
    case "ready":
      return `Synced via ${name}`;
    case "needs_reauth":
    case "error":
      return `Previously synced via ${name}`;
  }
}

function fmtSyncedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} • ${time}`;
}

function EyebrowHeading({ eyebrow, institution }: { eyebrow: string; institution: string }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-4">
        <Building2 className="w-4 h-4 text-[var(--meridian-400)]/90" />
        <p className="text-[10px] font-bold tracking-[0.18em] uppercase text-[var(--meridian-400)]/90">
          {eyebrow}
        </p>
      </div>
      <h2 className="text-lg md:text-xl font-semibold text-[var(--text-primary)] leading-tight">
        {institution}
      </h2>
    </>
  );
}

/**
 * Wallet-only refresh affordance. Reuses SyncWalletButton (POST
 * /api/accounts/[id]/sync). Manual refresh is recovery/freshness — the initial
 * sync runs automatically on add. Never rendered for Plaid (no reconnect logic).
 */
function WalletActions({ connection, accounts }: { connection: SyncConnection; accounts: AccountLite[] }) {
  if (connection.provider !== "WALLET") return null;
  const acct = accounts[0];
  if (!acct) return null;
  const syncStatus: "synced" | "pending" | "error" =
    connection.state === "ready" ? "synced" : connection.state === "error" ? "error" : "pending";
  return (
    <div className="mt-3">
      <SyncWalletButton accountId={acct.id} syncStatus={syncStatus} />
    </div>
  );
}

function AccountNames({ accounts }: { accounts: AccountLite[] }) {
  if (accounts.length === 0) return null;
  return (
    <ul className="mt-3 divide-y divide-[var(--border-hairline)] border-t border-[var(--border-hairline)]">
      {accounts.map((a) => (
        <li key={a.id} className="flex items-center gap-2 py-2 text-sm">
          <span className="text-[var(--text-secondary)] truncate">{a.name}</span>
        </li>
      ))}
    </ul>
  );
}

// ── State-specific content (same shell wraps each) ────────────────────────────

function ImportingContent({
  connection,
  accounts,
  slow,
}: {
  connection: SyncConnection;
  accounts:   AccountLite[];
  slow?:      boolean;
}) {
  // Wallets don't have Plaid's "institution/transaction-history" phases; while
  // pending they're discovering on-chain addresses. A large (behemoth) wallet
  // discovers across several passes — the Refresh action (rendered on the card)
  // continues it. Honest, not the Plaid stepper.
  if (connection.provider === "WALLET") {
    return (
      <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
        <EyebrowHeading eyebrow="Discovering addresses" institution={connection.institution} />
        <p className="mt-1.5 mb-4 text-sm text-[var(--text-secondary)] leading-relaxed max-w-md">
          Finding your wallet’s addresses on-chain and importing balances. A large wallet can take several passes — press Refresh to continue discovery.
        </p>
        <ul className="space-y-1.5">
          <DoneStatusRow label="Wallet connected" />
          <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <Loader2 size={15} className="animate-spin text-[var(--meridian-400)] shrink-0" />
            <span>Discovering addresses…{accounts.length > 0 ? ` (${accounts.length} so far)` : ""}</span>
          </li>
        </ul>
        <AccountNames accounts={accounts} />
      </div>
    );
  }
  // Stage TRUTH (which stage, what status) comes from the one lifecycle
  // authority; this card owns only the wording. For an importing Plaid
  // connection the projection yields connected/accounts/balances = done,
  // transactions = active, ready = pending — identical to the prior inline list.
  const stages: Stage[] = deriveConnectionLifecycle(connection).map((s) => {
    switch (s.key) {
      case "connected":
        return { label: "Institution connected", status: s.status };
      case "accountsDiscovered":
        return { label: "Accounts discovered", value: String(accounts.length), status: s.status };
      case "balancesImported":
        return { label: "Balances imported", status: s.status };
      case "transactionsImported":
        return {
          label:
            s.status === "active"
              ? slow
                ? "Transaction history — taking a little longer"
                : "Transaction history importing…"
              : "Transaction history imported",
          // Live count from the server-side import (SyncConnection.importedCount,
          // refreshed by the existing status poll). Shown only while this stage is
          // ACTIVE and only once it is non-zero: a "0 imported" that sits there
          // during Plaid's async preparation phase reads as failure, whereas no
          // number at all correctly reads as "still starting up". Deliberately a
          // bare count, not "N of M" — Plaid's sync API never reveals a total, and
          // a denominator we'd have to invent could only make the bar move
          // backwards.
          value:
            s.status === "active" && (connection.importedCount ?? 0) > 0
              ? `${connection.importedCount!.toLocaleString()} imported`
              : undefined,
          status: s.status,
        };
      default: // "ready"
        return { label: "Ready", status: s.status };
    }
  });

  return (
    <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
      <EyebrowHeading eyebrow="Building your profile" institution={connection.institution} />
      <p className="mt-1.5 mb-5 text-sm text-[var(--text-secondary)] leading-relaxed max-w-md">
        Building your financial profile — {providerLine(connection).toLowerCase()}.
      </p>

      <StageStepper stages={stages} />

      {/* The "ready next" list (Timeline · Daily Brief · AI insights) was removed
          here: those are roadmap promises, not work this import is doing or
          tracking. A progress card should report what is happening right now —
          anything else is a commitment the card cannot verify and the user
          cannot act on. Re-add a row only when there is a real signal behind it. */}
      {slow && (
        // CONN-1 — truthful framing once live polling has paused (past the ~3-min
        // budget). The import genuinely continues server-side; completion is
        // persisted (syncIncompleteAt → null) whether or not a notification lands.
        // We deliberately DON'T promise a push we can't guarantee — the best-effort
        // notification may not arrive and the poller has stopped — so we invite a
        // re-check instead. Reopening/refocusing this tab resumes live tracking.
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          Still importing — accounts with a lot of history can take several minutes.
          This keeps running in the background even if you leave; reopen Connections
          any time to check progress.
        </p>
      )}
      <AccountNames accounts={accounts} />
    </div>
  );
}

// ── Building your financial profile (transactions done, intelligence building) ─
// CONN-2C/2G — the connection reads "ready" (syncIncompleteAt cleared) but the
// derived intelligence (wealth timeline / cash flow / insights) is still being
// BUILT, before PLAID_HISTORY_SYNCED is written. The customer never knew a prior
// state existed, so this is "building your financial profile", never "rebuilding".
// Transactions/accounts are DONE facts; timeline/insights are in flight. No
// percentages — stages map to readiness, not backend jobs.
function BuildingProfileContent({
  connection,
  accounts,
  intelligence,
}: {
  connection:   SyncConnection;
  accounts:     AccountLite[];
  intelligence: ConnectionIntelligenceStatus;
}) {
  const stages: Stage[] = [
    { label: "Transactions available", value: String(accounts.length) + (accounts.length === 1 ? " account" : " accounts"), status: "done" },
    { label: "Accounts connected", status: "done" },
    { label: "Building your timeline", status: "active" },
    { label: "Generating insights", status: "pending" },
  ];
  const available = formatAvailableHistory(intelligence.availableHistory);
  return (
    <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
      <EyebrowHeading eyebrow="Building your financial profile" institution={connection.institution} />
      <p className="mt-1.5 mb-5 text-sm text-[var(--text-secondary)] leading-relaxed max-w-md">
        Your transactions are already available. Fourth Meridian is building your financial timeline and insights from them.
      </p>

      <StageStepper stages={stages} />

      {available !== "No historical data yet" && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{available} of history available</p>
      )}
      <p className="mt-3 text-xs text-[var(--text-muted)]">You can leave this page — this finishes in the background.</p>
      <AccountNames accounts={accounts} />
    </div>
  );
}

/**
 * CONN-3 — three UNAMBIGUOUS freshness lines. The card must never just say
 * "Synced" (which conflates data, intelligence, and balance). Each line is a
 * distinct L1/L2/L3 freshness signal, shown only when a real timestamp exists.
 */
function fmtFreshnessRelative(iso: string): string {
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.floor((day(new Date()) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function FreshnessRows({ intelligence }: { intelligence: ConnectionIntelligenceStatus }) {
  const rows: Array<{ label: string; verb: string; iso: string | null }> = [
    { label: "Transactions",      verb: "Updated",  iso: intelligence.lastSyncedAt },
    { label: "Financial profile", verb: "Built",    iso: intelligence.lastReconstructedAt },
    { label: "Balance",           verb: "Verified", iso: intelligence.balanceVerifiedAt },
  ];
  const shown = rows.filter((r) => r.iso);
  if (shown.length === 0) return null;
  return (
    <div className="mt-0.5 mb-4">
      {shown.map((r) => (
        <p key={r.label} className="text-sm text-[var(--text-muted)]">
          <span className="text-[var(--text-secondary)]">{r.label}:</span> {r.verb} {fmtFreshnessRelative(r.iso as string)}
        </p>
      ))}
    </div>
  );
}

function ReadyContent({
  connection,
  accounts,
  intelligence,
}: {
  connection:    SyncConnection;
  accounts:      AccountLite[];
  intelligence?: ConnectionIntelligenceStatus;
}) {
  const { lastSyncedAt } = connection;
  const count = accounts.length;
  // CONN-2G — "Financial profile ready" is only shown when intelligence is
  // actually READY. With no intelligence data (pre-CONN-2 fallback) the card
  // keeps the prior "Connected" framing.
  const profileReady = intelligence?.intelligenceReady === true;
  const available = intelligence ? formatAvailableHistory(intelligence.availableHistory) : null;
  return (
    <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
      <EyebrowHeading
        eyebrow={profileReady ? "Financial profile ready" : "Connected"}
        institution={connection.institution}
      />
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{providerLine(connection)}</p>
      {/* CONN-3 — three unambiguous freshness lines when intelligence data is
          present; otherwise the pre-CONN-3 single "Last synced" fallback. */}
      {intelligence ? (
        <FreshnessRows intelligence={intelligence} />
      ) : (
        lastSyncedAt && (
          <p className="mt-0.5 mb-4 text-sm text-[var(--text-muted)]">
            Last synced: {fmtSyncedAt(lastSyncedAt)}
          </p>
        )
      )}

      <p className="text-xs font-semibold uppercase tracking-widest text-[var(--text-muted)] mt-1 mb-2">
        {count} {count === 1 ? "account" : "accounts"}
      </p>

      {/* Honest status rows only — Transaction history is verifiable at ready
          (cursor is set). Daily Brief / AI are NOT shown as complete. */}
      <ul className="space-y-1.5">
        <DoneStatusRow label="Transaction history imported" />
        {profileReady && <DoneStatusRow label="Financial intelligence built" />}
      </ul>

      {available && available !== "No historical data yet" && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">{available} of history available</p>
      )}

      {/* Connection-specific Investments capability (Plaid only). */}
      <InvestmentsCapability connection={connection} />

      <AccountNames accounts={accounts} />

      {/* CONN-2D — provider-neutral lifecycle timeline (collapsible). */}
      {intelligence && <ConnectionTimeline intelligence={intelligence} />}
    </div>
  );
}

function NeedsReauthContent({
  connection,
  accounts,
}: {
  connection: SyncConnection;
  accounts:   AccountLite[];
}) {
  return (
    <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <EyebrowHeading eyebrow="Needs reauthentication" institution={connection.institution} />
        </div>
        <ReconnectAccountButton plaidItemId={connection.id} />
      </div>
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{providerLine(connection)}</p>
      <p className="mt-0.5 text-sm text-[var(--accent-warning,#f59e0b)]">Reconnect required</p>
      <AccountNames accounts={accounts} />
    </div>
  );
}

function ErrorContent({
  connection,
  accounts,
}: {
  connection: SyncConnection;
  accounts:   AccountLite[];
}) {
  const { errorCode, provider } = connection;
  // Retry honesty. Neither provider is retried automatically in THIS state:
  //   - Wallets have no scheduled crypto sync at all.
  //   - Plaid's daily sync-banks selects `status: ACTIVE`, and this card only
  //     renders for ERROR — so an errored connection is skipped by every
  //     scheduled run. The previous copy ("We'll keep retrying") was written on
  //     the assumption that the cron covered it; it does not, and it never did
  //     for this state.
  // Retry here is user-initiated. Do not promise behavior that doesn't exist.
  const isWallet = provider === "WALLET";

  // Valid extended key, but discovery found NO on-chain-used addresses. This is
  // not a sync failure — most often the wrong address type was exported (e.g. a
  // native-segwit account pasted as a legacy xpub). Show calm, actionable
  // guidance rather than the red "Sync error" framing.
  if (isWallet && errorCode === "NO_USED_ADDRESSES") {
    return (
      <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
        <EyebrowHeading eyebrow="No activity found" institution={connection.institution} />
        <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{providerLine(connection)}</p>
        <div className="mt-1.5 flex items-start gap-2 text-sm text-[var(--text-secondary)]">
          <Info size={15} className="shrink-0 mt-0.5" />
          <span>
            Valid xpub, but no used addresses were found. This may be the wrong address type.
            Try the Native SegWit zpub/export for this account.
          </span>
        </div>
        <AccountNames accounts={accounts} />
      </div>
    );
  }

  const walletDetail =
    errorCode === "RATE_LIMITED"       ? "the Bitcoin explorer is rate-limiting requests"
    : errorCode === "DISCOVERY_FAILED" ? "the explorer was temporarily unavailable or timed out"
    : errorCode === "INVALID_XPUB"     ? "this doesn’t look like a valid extended public key (xpub/ypub/zpub)"
    : errorCode;
  return (
    <div className="flex flex-col min-h-[200px] md:min-h-[220px]">
      <EyebrowHeading eyebrow="Sync error" institution={connection.institution} />
      <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{providerLine(connection)}</p>
      <div className="mt-1.5 flex items-start gap-2 text-sm text-[var(--accent-warning,#f59e0b)]">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>
          {isWallet
            ? "We couldn’t complete address discovery for this wallet. Press Refresh to retry discovery."
            : errorCode === "ITEM_NOT_FOUND"
              // Terminal and unambiguous: the Item no longer exists at Plaid
              // (removed here, or access withdrawn at the institution). No amount
              // of retrying can find it — reconnecting is the only route back, so
              // say that instead of implying patience will fix it.
              ? "This connection no longer exists at your provider. Reconnect to restore it."
              : `We hit a problem syncing this connection${errorCode ? ` (${errorCode})` : ""}. Automatic syncing has stopped — reconnect to resume it.`}
        </span>
      </div>
      {isWallet && errorCode && (
        <p className="mt-1.5 text-xs text-[var(--text-muted)]">Address discovery failed: {walletDetail}.</p>
      )}
      <AccountNames accounts={accounts} />
    </div>
  );
}

// ── Canonical card ────────────────────────────────────────────────────────────

export function ConnectionCard({ connection, accounts, intelligence, slow, allowLiquid = true }: Props) {
  const { state, institution } = connection;
  const capable = useAtlasLiquid();
  const canLiquid = capable && allowLiquid;

  let content: React.ReactNode;
  switch (state) {
    case "importing":
      content = <ImportingContent connection={connection} accounts={accounts} slow={slow} />;
      break;
    case "ready":
      // CONN-2G — "ready" transactions ≠ "Fourth Meridian ready". While derived
      // intelligence is still building (BUILDING_INTELLIGENCE), show the
      // building-profile lifecycle, not the Connected/ready card. Only READY
      // intelligence (or no intelligence data — pre-CONN-2 fallback) shows ReadyContent.
      content = intelligence && intelligence.phase === "BUILDING_INTELLIGENCE"
        ? <BuildingProfileContent connection={connection} accounts={accounts} intelligence={intelligence} />
        : <ReadyContent connection={connection} accounts={accounts} intelligence={intelligence} />;
      break;
    case "needs_reauth":
      content = <NeedsReauthContent connection={connection} accounts={accounts} />;
      break;
    case "error":
      content = <ErrorContent connection={connection} accounts={accounts} />;
      break;
  }

  // Unified shell — same card family for every state. Liquid when allowed
  // (capability gate AND within the list's cap), else the Glass DataCard
  // fallback. AtlasLiquidCard zeroes its own content padding and uses the
  // default frosted preset + Brief content geometry (relative z-10 +
  // px-6 md:px-8 py-6 md:py-7) so the glass has real area to refract.
  // Wallet cards get a reuse of SyncWalletButton (recovery/freshness) — rendered
  // once, in every wallet state; returns null for Plaid so those are unchanged.
  // CONN-4A — per-connection ⋯ menu (Refresh / Restore intelligence / Disconnect).
  // Shown once the connection has resolved (not mid-import).
  const menu = state !== "importing"
    ? <div className="absolute right-3 top-3 z-30"><ConnectionMenu connection={connection} /></div>
    : null;

  const walletActions = <WalletActions connection={connection} accounts={accounts} />;
  // A7-6 — capability-aware historical-import affordance. Renders nothing unless
  // this is a Plaid connection (past first import) with an investment account, so
  // banking-only and wallet cards are unchanged.
  const importAction = <ImportHistoryButton connection={connection} accounts={accounts} />;

  return canLiquid ? (
    <AtlasLiquidCard ariaLabel={`${institution} — ${state}`}>
      <div className="relative z-10 px-6 md:px-8 py-6 md:py-7">{menu}{content}{walletActions}{importAction}</div>
    </AtlasLiquidCard>
  ) : (
    <DataCard accent={state === "error" ? "negative" : "none"}>
      <div className="relative">{menu}{content}{walletActions}{importAction}</div>
    </DataCard>
  );
}
