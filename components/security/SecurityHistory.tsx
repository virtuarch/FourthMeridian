"use client";

/**
 * components/security/SecurityHistory.tsx  (OPS-2 S1)
 *
 * User-facing security history for the Security Center. Renders the caller's
 * own allowlisted security events from /api/user/security-history (safe fields
 * only — the route does the filtering/scoping). Read-only; last 50.
 */

import { useEffect, useState } from "react";
import { Loader2, Globe } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { formatDevice, type ParsedUA } from "@/lib/ua-parser";

type SecurityEvent = {
  id:        string;
  action:    string;
  label:     string;
  createdAt: string;
  ipAddress: string | null;
  parsed:    ParsedUA;
  reason:    string | null;
};

const FAILURE_ACTIONS = new Set(["LOGIN_FAILED", "PASSWORD_CHANGE_FAILED"]);

export function SecurityHistory() {
  const [events,  setEvents]  = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res  = await fetch("/api/user/security-history");
        const data = await res.json().catch(() => ({ events: [] }));
        setEvents(Array.isArray(data.events) ? data.events : []);
      } catch {
        setEvents([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-gray-500">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="text-xs text-gray-600 py-4 text-center">No security activity recorded yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {events.map((e) => {
        const isFailure = FAILURE_ACTIONS.has(e.action);
        return (
          <div
            key={e.id}
            className="flex items-start justify-between gap-3 p-2.5 rounded-xl bg-gray-800/20 border border-gray-800/40"
          >
            <div className="min-w-0 space-y-0.5">
              <p className={`text-xs font-medium ${isFailure ? "text-red-400" : "text-gray-200"}`}>
                {e.label}
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-gray-600">{formatDevice(e.parsed)}</span>
                {e.ipAddress && (
                  <span className="flex items-center gap-1 text-xs text-gray-600 font-mono">
                    <Globe size={10} /> {e.ipAddress}
                  </span>
                )}
              </div>
            </div>
            <span className="shrink-0 text-xs text-gray-600" suppressHydrationWarning>
              {formatDateTime(e.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
