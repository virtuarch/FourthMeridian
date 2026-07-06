"use client";

/**
 * components/security/DeleteAccountCard.tsx  (OPS-2 S7b)
 *
 * Delete-account form for the Security Center. Reversible pending-deletion
 * REQUEST — clones DeactivateAccountCard: an "I want to delete" reveal, then a
 * current-password confirm posting to /api/user/delete. On success every
 * session is revoked server-side, so we signOut() to clear the local cookie
 * and land on /login (where the "Cancel deletion" affordance lives).
 *
 * Two things sit inside the reveal, per the S7b design:
 *   - "Download my data first" → POST /api/user/export (S6), streamed as a ZIP.
 *   - a 409 sole-OWNER block renders the blocking Spaces with resolution copy.
 *
 * Presentation + wiring only; re-auth, preflight, session revocation, email,
 * and audit live in the route. NOTHING is deleted here — the account is
 * recoverable for the whole grace window (copy stresses reversibility).
 */

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2, Trash2, Download } from "lucide-react";

const GRACE_DAYS = 7;

export function DeleteAccountCard() {
  const [open,        setOpen]        = useState(false);
  const [currentPw,   setCurrentPw]   = useState("");
  const [loading,     setLoading]     = useState(false);
  const [exporting,   setExporting]   = useState(false);
  const [error,       setError]       = useState("");
  const [blockedList, setBlockedList] = useState<string[]>([]);

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setError("");
    try {
      const res = await fetch("/api/user/export", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Couldn't export your data. Please try again.");
        setExporting(false);
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `fourth-meridian-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Something went wrong exporting your data. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBlockedList([]);
    if (!currentPw) return;
    setLoading(true);
    try {
      const res  = await fetch("/api/user/delete", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ currentPassword: currentPw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 sole-OWNER block — surface the Spaces the user must resolve first.
        if (res.status === 409 && Array.isArray(data.blockingSpaces)) {
          setBlockedList(data.blockingSpaces.map((s: { name: string }) => s.name));
        }
        setError(data.error ?? "Couldn't schedule deletion. Please try again.");
        setLoading(false);
        return;
      }
      // All sessions (including this one) are already revoked server-side —
      // signOut clears the local cookie and returns the user to /login, where
      // they can still cancel by signing back in during the grace window.
      await signOut({ callbackUrl: "/login" });
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  const inputClass =
    "w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-red-500/60 transition-colors";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-xl border transition-colors"
        style={{
          color:       "var(--accent-negative)",
          borderColor: "rgba(237,82,71,0.30)",
          background:  "rgba(237,82,71,0.06)",
        }}
      >
        <Trash2 size={14} />
        Delete account
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && (
        <div
          className="rounded-xl border px-3 py-2.5 text-sm"
          style={{ background: "rgba(237,82,71,0.10)", borderColor: "rgba(237,82,71,0.30)", color: "var(--accent-negative)" }}
        >
          {error}
          {blockedList.length > 0 && (
            <ul className="mt-2 list-disc list-inside space-y-0.5">
              {blockedList.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div
        className="rounded-xl border px-3 py-2.5 text-xs"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-muted)" }}
      >
        You&apos;ll be signed out everywhere and your account will be scheduled
        for permanent deletion in {GRACE_DAYS} days. You can cancel any time
        before then by signing back in and choosing &quot;Cancel deletion&quot;.
        After the {GRACE_DAYS}-day window, your account and all your data are
        permanently removed and cannot be recovered.
      </div>

      <button
        type="button"
        onClick={handleExport}
        disabled={exporting || loading}
        className="flex items-center gap-2 text-sm font-medium px-4 py-2.5 rounded-xl border transition-colors disabled:opacity-50"
        style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
      >
        {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        Download my data first
      </button>

      <div>
        <label className="block text-xs mb-1.5" style={{ color: "var(--text-muted)" }}>
          Confirm your password
        </label>
        <input
          type="password"
          value={currentPw}
          onChange={(e) => setCurrentPw(e.target.value)}
          required
          className={inputClass}
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={loading || !currentPw}
          className="flex items-center gap-2 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2.5 rounded-xl transition-colors"
          style={{ background: "var(--accent-negative)" }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          Delete my account
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setCurrentPw(""); setError(""); setBlockedList([]); }}
          disabled={loading}
          className="text-sm px-4 py-2.5 rounded-xl border transition-colors disabled:opacity-50"
          style={{ color: "var(--text-secondary)", borderColor: "var(--border-hairline)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
