"use client";

/**
 * components/settings/NotificationSettings.tsx  (OPS-3 S3)
 *
 * The category × channel preference matrix. Rendered FROM the server-loaded
 * effective matrix (registry defaults ⊕ overrides — the registry stays the
 * single definition site; this component knows no per-category defaults).
 *
 * Locked categories (ACCOUNT_SECURITY) render checked-and-disabled with the
 * frozen note — the API also rejects writes for them (defense in depth).
 * Toggles PATCH /api/user/notification-preferences one cell at a time,
 * optimistic with rollback on failure (the settings-card idiom).
 */

import { useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";
import type {
  PreferenceChannel,
  PreferenceMatrixRow,
} from "@/lib/notifications/preferences";

const CHANNEL_LABELS: Record<PreferenceChannel, string> = {
  IN_APP: "In-app",
  EMAIL: "Email",
};
const CHANNELS = Object.keys(CHANNEL_LABELS) as PreferenceChannel[];

const CATEGORY_LABELS: Record<string, { title: string; desc: string }> = {
  ACCOUNT_SECURITY: { title: "Account & Security", desc: "Password, email, sign-in, and account lifecycle alerts." },
  SPACES:           { title: "Spaces",             desc: "Invitations, membership, and role changes." },
  FINANCIAL:        { title: "Financial",          desc: "Sync problems, duplicates, and imports." },
  AI:               { title: "Intelligence",       desc: "Briefs, opportunities, and alerts from your agents." },
  PLATFORM:         { title: "Platform",           desc: "Maintenance, new features, and policy updates." },
};

export function NotificationSettings({ matrix }: { matrix: PreferenceMatrixRow[] }) {
  const [rows, setRows] = useState(matrix);
  const [savingCell, setSavingCell] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function toggle(category: string, channel: PreferenceChannel, enabled: boolean) {
    const cell = `${category}:${channel}`;
    setSavingCell(cell);
    setError("");
    // Optimistic flip …
    setRows((prev) =>
      prev.map((r) =>
        r.category === category ? { ...r, channels: { ...r.channels, [channel]: enabled } } : r,
      ),
    );
    try {
      const res = await fetch("/api/user/notification-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, channel, enabled }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "Could not save.");
    } catch (e) {
      // … rolled back on failure.
      setRows((prev) =>
        prev.map((r) =>
          r.category === category ? { ...r, channels: { ...r.channels, [channel]: !enabled } } : r,
        ),
      );
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSavingCell(null);
    }
  }

  return (
    <DataCard>
      <div className="flex items-center gap-2 mb-1">
        <BellRing size={15} style={{ color: "var(--text-secondary)" }} />
        <DataCardTitle>Notification preferences</DataCardTitle>
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>
        Choose where each kind of notification reaches you. Changes apply to new
        notifications.
      </p>

      {error && (
        <div
          className="rounded-xl border px-3 py-2 text-sm mb-3"
          style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" }}
        >
          {error}
        </div>
      )}

      {/* Column headers */}
      <div className="flex items-center justify-end gap-6 px-4 pb-1">
        {CHANNELS.map((ch) => (
          <span key={ch} className="w-12 text-center text-[10px] font-semibold uppercase tracking-widest" style={{ color: "var(--text-faint)" }}>
            {CHANNEL_LABELS[ch]}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {rows.map((row) => {
          const labels = CATEGORY_LABELS[row.category] ?? { title: row.category, desc: "" };
          return (
            <div
              key={row.category}
              className="flex items-center justify-between gap-4 px-4 py-3 rounded-xl border"
              style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
            >
              <div className="min-w-0">
                <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{labels.title}</p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {row.locked ? "Security notifications can't be turned off." : labels.desc}
                </p>
              </div>
              <div className="flex items-center gap-6 shrink-0">
                {CHANNELS.map((ch) => {
                  const cell = `${row.category}:${ch}`;
                  const busy = savingCell === cell;
                  return (
                    <span key={ch} className="w-12 flex justify-center">
                      {busy ? (
                        <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} />
                      ) : (
                        <input
                          type="checkbox"
                          checked={row.channels[ch]}
                          disabled={row.locked || savingCell !== null}
                          onChange={(e) => toggle(row.category, ch, e.target.checked)}
                          aria-label={`${labels.title} — ${CHANNEL_LABELS[ch]}`}
                          className="w-4 h-4 accent-blue-500 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        />
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] mt-3" style={{ color: "var(--text-faint)" }}>
        Email delivery for these categories begins when notification emails
        launch; your choices here are respected from day one.
      </p>
    </DataCard>
  );
}
