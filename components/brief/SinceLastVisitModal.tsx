"use client";

/**
 * SinceLastVisitModal
 *
 * Detailed window shown when the user clicks the "Since Your Last Visit" panel.
 *
 * v2 scope — data tabs (replaces the earlier time-range tabs):
 *   - Tab 1 "Net Worth"        — the existing summary items (net worth, etc.)
 *   - Tab 2 "Accounts Tracked" — distinct, privacy-safe roster of tracked
 *                                FinancialAccounts (deduped by id across Spaces;
 *                                length matches the "Accounts tracked" count)
 *   - Tab 3 / Tab 4            — reserved (honest "coming soon" state)
 *
 * The roster arrives on section.trackedAccounts (built server-side; no balances,
 * institution/mask only for FULL visibility). The UI performs no data queries.
 */

import { useState } from "react";
import { BriefModal } from "./BriefModal";
import { InlineFilter } from "@/components/atlas/InlineFilter";
import {
  TONE_VALUE,
  TONE_ICON,
  CATEGORY_ICON,
  CATEGORY_CHIP_BG,
  categoryFromItemId,
} from "@/components/atlas/tones";
import type { BriefSection, BriefTone, TrackedAccount } from "@/lib/brief-types";
import {
  TrendingUp,
  TrendingDown,
  Landmark,
  Target,
  Bell,
  Activity,
  Clock,
  CreditCard,
  Wallet,
  Coins,
  Home,
  Building2,
} from "lucide-react";

// ── Data tab strip ────────────────────────────────────────────────────────────

const TABS = [
  { id: "netWorth",  label: "Net Worth",        kind: "data"     },
  { id: "accounts",  label: "Accounts Tracked", kind: "data"     },
  { id: "reserved3", label: "Reserved",         kind: "reserved" },
  { id: "reserved4", label: "Reserved",         kind: "reserved" },
] as const;

type TabId = typeof TABS[number]["id"];

// ── Icon chip (summary items) ─────────────────────────────────────────────────

function ItemIcon({ id, tone }: { id: string; tone?: BriefTone }) {
  const category = categoryFromItemId(id);
  const colorCls = category === "netWorth" ? TONE_ICON[tone ?? "neutral"] : CATEGORY_ICON[category];
  const cls = `w-4 h-4 ${colorCls}`;
  if (id.startsWith("nw_up"))   return <TrendingUp className={cls} />;
  if (id.startsWith("nw_down")) return <TrendingDown className={cls} />;
  if (id.startsWith("nw"))      return <TrendingUp className={cls} />;
  if (category === "cash")      return <Landmark className={cls} />;
  if (category === "pending")   return <Bell className={cls} />;
  if (category === "goal")      return <Target className={cls} />;
  return <Activity className={cls} />;
}

// Semantic icon chip — circular glass-tinted background keyed to the same
// category color used everywhere else on the brief.
function ItemIconChip({ id, tone }: { id: string; tone?: BriefTone }) {
  const category = categoryFromItemId(id);
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 border ${CATEGORY_CHIP_BG[category]}`}
    >
      <ItemIcon id={id} tone={tone} />
    </div>
  );
}

// ── Components ────────────────────────────────────────────────────────────────

function ComingSoonState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--surface-muted)] border border-[var(--border-hairline)] flex items-center justify-center">
        <Clock className="w-5 h-5 text-[var(--text-muted)]" />
      </div>
      <p className="text-sm font-medium text-[var(--text-secondary)]">
        {label} coming soon
      </p>
      <p className="text-xs text-[var(--text-muted)] max-w-xs">
        This space is reserved for an upcoming Daily Brief detail view.
      </p>
    </div>
  );
}

// Row lives directly on the modal's own glass surface — no card, no divider.
function SummaryItem({
  id,
  label,
  value,
  detail,
  tone,
}: {
  id: string;
  label: string;
  value?: string;
  detail?: string;
  tone?: BriefTone;
}) {
  const valueCls = TONE_VALUE[tone ?? "neutral"];
  return (
    <div className="flex items-start gap-3 py-3.5">
      <ItemIconChip id={id} tone={tone} />
      <div className="flex-1 min-w-0 pt-0.5">
        <p className="text-sm text-[var(--text-secondary)] leading-snug">{label}</p>
        {detail && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{detail}</p>
        )}
      </div>
      {value && (
        <span className={`text-sm tabular-nums shrink-0 pt-0.5 ${valueCls}`}>{value}</span>
      )}
    </div>
  );
}

// ── Accounts Tracked roster ───────────────────────────────────────────────────

// Icon keyed to account type. Falls back to a neutral wallet.
function AccountIcon({ type }: { type: string }) {
  const cls = "w-4 h-4 text-[var(--text-secondary)]";
  switch (type) {
    case "cash":
    case "depository": return <Landmark className={cls} />;
    case "investment": return <TrendingUp className={cls} />;
    case "crypto":
    case "digital":    return <Coins className={cls} />;
    case "debt":       return <CreditCard className={cls} />;
    case "property":
    case "real":       return <Home className={cls} />;
    case "business":   return <Building2 className={cls} />;
    default:           return <Wallet className={cls} />;
  }
}

// Human-readable fallback label for an account type (used as the row subline
// when institution/mask are withheld for privacy).
function typeLabel(type: string): string {
  switch (type) {
    case "cash":
    case "depository": return "Cash account";
    case "investment": return "Investment account";
    case "crypto":
    case "digital":    return "Digital asset";
    case "debt":       return "Debt account";
    case "property":
    case "real":       return "Real asset";
    case "business":   return "Business account";
    default:           return "Account";
  }
}

function AccountRow({ account }: { account: TrackedAccount }) {
  // FULL visibility may show institution + last-4; restricted visibility shows
  // only a human type label (institution/mask are never present in the payload).
  const subline =
    account.institution
      ? account.mask
        ? `${account.institution} ···· ${account.mask}`
        : account.institution
      : typeLabel(account.type);

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-[var(--border-hairline)] bg-[var(--surface-muted)]">
        <AccountIcon type={account.type} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-secondary)] leading-snug truncate">{account.name}</p>
        <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{subline}</p>
      </div>
    </div>
  );
}

function AccountsTracked({ accounts }: { accounts: TrackedAccount[] }) {
  if (accounts.length === 0) {
    return (
      <div className="py-10 text-center">
        <p className="text-sm text-[var(--text-muted)]">No accounts are being tracked yet.</p>
      </div>
    );
  }
  return (
    <>
      <p className="text-xs text-[var(--text-muted)] mb-1">
        {accounts.length} distinct {accounts.length === 1 ? "account" : "accounts"} tracked across your Spaces.
      </p>
      <div className="flex flex-col divide-y divide-[var(--border-hairline)]">
        {accounts.map(a => (
          <AccountRow key={a.id} account={a} />
        ))}
      </div>
    </>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

interface SinceLastVisitModalProps {
  open: boolean;
  onClose: () => void;
  section: BriefSection;
}

export function SinceLastVisitModal({ open, onClose, section }: SinceLastVisitModalProps) {
  const [activeTab, setActiveTab] = useState<TabId>("netWorth");
  const activeTabMeta = TABS.find(t => t.id === activeTab)!;
  // Net Worth tab shows only net-worth rows — never Accounts Tracked or Space
  // invites. Those are surfaced in their own tabs (or reserved for future ones).
  const netWorthItems   = (section.items ?? []).filter(
    item => item.id === "nw_delta" || item.id === "nw_current",
  );
  const trackedAccounts = section.trackedAccounts ?? [];

  return (
    <BriefModal
      open={open}
      onClose={onClose}
      title="Since Your Last Visit"
      wide
      headerRight={
        <InlineFilter
          aria-label="Detail view"
          options={TABS.map(t => ({ id: t.id, label: t.label }))}
          value={activeTab}
          onChange={setActiveTab}
        />
      }
    >
      {activeTabMeta.kind === "reserved" ? (
        <ComingSoonState label={activeTabMeta.label} />
      ) : activeTab === "accounts" ? (
        <AccountsTracked accounts={trackedAccounts} />
      ) : (
        // Net Worth tab — net-worth rows only.
        <>
          {netWorthItems.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-[var(--text-muted)]">No net worth changes since your last visit.</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {netWorthItems.map(item => (
                <SummaryItem
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  value={item.value}
                  detail={item.detail}
                  tone={item.tone}
                />
              ))}
            </div>
          )}

          <p className="text-xs text-[var(--text-muted)] mt-8 text-center">
            Showing changes since your last Daily Brief visit.
          </p>
        </>
      )}
    </BriefModal>
  );
}
