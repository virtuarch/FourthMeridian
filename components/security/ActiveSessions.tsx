"use client";

/**
 * components/security/ActiveSessions.tsx  (OPS-2 S1)
 *
 * User-facing active-sessions panel for the Security Center. Fetches the
 * caller's own sessions and renders the shared <SessionsList> with user-scoped
 * revoke callbacks (/api/user/sessions*). All authorization + auditing lives in
 * those routes; this is presentation + wiring only.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { SessionsList, type SessionRow } from "@/components/security/SessionsList";

async function fetchSessions(): Promise<SessionRow[]> {
  try {
    const res  = await fetch("/api/user/sessions");
    const data = await res.json().catch(() => ({ sessions: [] }));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

export function ActiveSessions() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading,  setLoading]  = useState(true);

  // Inline async IIFE: state is only set AFTER the await, never synchronously
  // inside the effect body.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchSessions();
      if (!cancelled) {
        setSessions(s);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleRevoke(id: string, isCurrent: boolean) {
    await fetch(`/api/user/sessions/${id}${isCurrent ? "?confirmSelf=true" : ""}`, { method: "DELETE" });
    setSessions(await fetchSessions());
  }

  async function handleRevokeAll() {
    await fetch("/api/user/sessions", { method: "DELETE" });
    setSessions(await fetchSessions());
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-gray-500">
        <Loader2 size={16} className="animate-spin" />
      </div>
    );
  }

  return (
    <SessionsList
      sessions={sessions}
      onRevoke={handleRevoke}
      onRevokeAll={handleRevokeAll}
      revokeAllLabel="Sign out everywhere else"
    />
  );
}
