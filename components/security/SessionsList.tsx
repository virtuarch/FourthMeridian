"use client";

/**
 * components/security/SessionsList.tsx  (OPS-2 S1)
 *
 * Shared active-sessions list, used by both the admin Security dashboard
 * (admin-self + per-user modal) and the user-facing Security Center card in
 * Settings. Extracted verbatim from app/admin/security/page.tsx so behavior is
 * identical across both surfaces — the component is transport-agnostic and
 * takes its revoke callbacks from the caller (admin endpoints vs.
 * /api/user/sessions*).
 */

import { useState } from "react";
import { Smartphone, Tablet, Monitor, Globe, LogOut, ChevronDown } from "lucide-react";
import { ParsedUA } from "@/lib/ua-parser";
import { formatDateTime } from "@/lib/format";

export type SessionRow = {
  id:           string;
  userId:       string;
  sessionToken: string;
  ipAddress:    string | null;
  userAgent:    string | null;
  lastActiveAt: string;
  revokedAt:    string | null;
  createdAt:    string;
  isCurrent?:   boolean;
  parsed:       ParsedUA;
};

function fmtDateTime(d: string | null) {
  if (!d) return "Never";
  return formatDateTime(d);
}

function fmtRelative(d: string | null) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)    return "Just now";
  if (mins < 60)   return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  return `${days}d ago`;
}

function DeviceIcon({ device }: { device: string }) {
  if (/phone|iphone|android phone/i.test(device)) return <Smartphone size={13} className="text-gray-400" />;
  if (/tablet|ipad/i.test(device))                return <Tablet      size={13} className="text-gray-400" />;
  return <Monitor size={13} className="text-gray-400" />;
}

export function SessionsList({
  sessions,
  onRevoke,
  onRevokeAll,
  revokeAllLabel = "Revoke all other sessions",
  showRevokeAll  = true,
}: {
  sessions:       SessionRow[];
  onRevoke:       (id: string, isCurrent: boolean) => Promise<void>;
  onRevokeAll:    () => Promise<void>;
  revokeAllLabel?: string;
  showRevokeAll?:  boolean;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmSelfId, setConfirmSelfId] = useState<string | null>(null);

  const active = sessions.filter((s) => !s.revokedAt);
  const revoked = sessions.filter((s) => s.revokedAt);

  async function handleRevoke(s: SessionRow) {
    if (s.isCurrent && confirmSelfId !== s.id) {
      setConfirmSelfId(s.id);
      return;
    }
    setRevoking(s.id);
    await onRevoke(s.id, !!s.isCurrent);
    setRevoking(null);
    setConfirmSelfId(null);
  }

  if (sessions.length === 0) {
    return <p className="text-xs text-gray-600 py-4 text-center">No sessions recorded yet.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Active sessions */}
      {active.length > 0 && (
        <div className="space-y-2">
          {active.map((s) => (
            <div
              key={s.id}
              className={`flex items-start justify-between gap-3 p-3 rounded-xl border transition-colors ${
                s.isCurrent
                  ? "bg-blue-500/5 border-blue-500/20"
                  : "bg-gray-800/30 border-gray-800"
              }`}
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <div className="mt-0.5 shrink-0">
                  <DeviceIcon device={s.parsed.device} />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-medium text-white">{s.parsed.browser}</span>
                    <span className="text-xs text-gray-500">on {s.parsed.os}</span>
                    <span className="text-xs text-gray-600">· {s.parsed.device}</span>
                    {s.isCurrent && (
                      <span className="text-xs font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 px-1.5 py-0.5 rounded-full">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {s.ipAddress && (
                      <span className="flex items-center gap-1 text-xs text-gray-600 font-mono">
                        <Globe size={10} /> {s.ipAddress}
                      </span>
                    )}
                    <span className="text-xs text-gray-600">Started {fmtDateTime(s.createdAt)}</span>
                    <span className="text-xs text-gray-600" suppressHydrationWarning>Active {fmtRelative(s.lastActiveAt)}</span>
                  </div>
                  {confirmSelfId === s.id && (
                    <p className="text-xs text-amber-400 mt-1">
                      This is your current session. Click Revoke again to confirm.
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleRevoke(s)}
                disabled={revoking === s.id}
                className={`shrink-0 text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-40 ${
                  confirmSelfId === s.id
                    ? "bg-red-500/20 border-red-500/40 text-red-400 hover:bg-red-500/30"
                    : "bg-gray-800 border-gray-700 text-gray-500 hover:text-red-400 hover:border-red-500/30"
                }`}
              >
                {revoking === s.id ? "…" : confirmSelfId === s.id ? "Confirm" : "Revoke"}
              </button>
            </div>
          ))}
        </div>
      )}

      {active.length === 0 && <p className="text-xs text-gray-600 text-center py-2">No active sessions.</p>}

      {/* Revoke all button */}
      {showRevokeAll && active.filter((s) => !s.isCurrent).length > 0 && (
        <button
          onClick={onRevokeAll}
          className="flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 border border-orange-500/20 hover:border-orange-500/40 px-3 py-1.5 rounded-lg transition-colors"
        >
          <LogOut size={11} />
          {revokeAllLabel}
        </button>
      )}

      {/* Recently revoked */}
      {revoked.length > 0 && (
        <details className="group">
          <summary className="text-xs text-gray-600 cursor-pointer hover:text-gray-400 transition-colors list-none flex items-center gap-1.5 pt-2 border-t border-gray-800/60">
            <ChevronDown size={11} className="group-open:rotate-180 transition-transform" />
            {revoked.length} revoked / expired session{revoked.length !== 1 ? "s" : ""}
          </summary>
          <div className="mt-2 space-y-1.5">
            {revoked.map((s) => (
              <div key={s.id} className="flex items-center gap-2.5 p-2.5 rounded-xl bg-gray-800/20 border border-gray-800/40 opacity-50">
                <DeviceIcon device={s.parsed.device} />
                <div className="min-w-0">
                  <p className="text-xs text-gray-500">{s.parsed.browser} on {s.parsed.os}</p>
                  <p className="text-xs text-gray-700">Revoked {fmtDateTime(s.revokedAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
