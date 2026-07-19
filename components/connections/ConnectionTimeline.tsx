"use client";

/**
 * components/connections/ConnectionTimeline.tsx  (CONN-2D)
 *
 * The customer "Connection Truth Timeline" — a lightweight, PROVIDER-NEUTRAL
 * explanation of where a financial source is in its lifecycle. It is a pure
 * projection of ConnectionIntelligenceStatus (deriveConnectionTimeline), never a
 * new source of truth. Four honest layers:
 *
 *   Authorization    → the source is connected
 *   Data acquisition → transactions are available (a fact, not a job)
 *   Financial intelligence → wealth timeline + cash flow are built
 *   Current freshness → when data was last updated (freshness, not rebuilt intel)
 *
 * NO provider/Plaid terms, NO item ids/tokens, NO internal sync/job names. A
 * timestamp is shown only when a real one exists — never fabricated.
 */

import { useState } from "react";
import { ChevronDown, Check, Circle } from "lucide-react";
import {
  deriveConnectionTimeline,
  type ConnectionIntelligenceStatus,
} from "@/lib/connections/intelligence";

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function fmtRelative(iso: string | null): string | null {
  if (!iso) return null;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.floor((day(new Date()) - day(new Date(iso))) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function Fact({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
      {done
        ? <Check size={14} className="shrink-0 text-[var(--accent-positive,#34d399)]" />
        : <Circle size={13} className="shrink-0 text-[var(--text-muted)] opacity-60" />}
      <span>{children}</span>
    </li>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</p>
      <ul className="mt-1.5 space-y-1">{children}</ul>
    </div>
  );
}

export function ConnectionTimeline({ intelligence }: { intelligence: ConnectionIntelligenceStatus }) {
  const [open, setOpen] = useState(false);
  const t = deriveConnectionTimeline(intelligence);

  const connectedOn = fmtDate(t.authorization.connectedAt);
  const lastUpdated = fmtRelative(t.freshness.lastUpdatedAt);

  return (
    <div className="mt-4 border-t border-[var(--border-hairline)] pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      >
        <span>Connection details</span>
        <ChevronDown size={15} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {connectedOn && (
            <Group label="Authorization">
              <Fact done>Connected {connectedOn}</Fact>
            </Group>
          )}

          <Group label="Data acquisition">
            <Fact done={t.acquisition.transactionsAvailable}>
              {t.acquisition.transactionsAvailable ? "Transactions available" : "Awaiting your transactions"}
            </Fact>
          </Group>

          <Group label="Financial intelligence">
            {t.intelligence.profileBuilt ? (
              <>
                <Fact done>Wealth timeline built</Fact>
                {t.intelligence.cashFlow && <Fact done>Cash flow available</Fact>}
              </>
            ) : (
              <Fact done={false}>Building your financial intelligence</Fact>
            )}
          </Group>

          {lastUpdated && (
            <Group label="Current freshness">
              <Fact done>Last updated {lastUpdated}</Fact>
            </Group>
          )}
        </div>
      )}
    </div>
  );
}
