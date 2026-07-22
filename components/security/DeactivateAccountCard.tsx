"use client";

/**
 * components/security/DeactivateAccountCard.tsx  (OPS-2 S4)
 *
 * Deactivate-account form for the Security Center. Two-step: an "I want to
 * deactivate" reveal, then current-password confirm posting to
 * /api/user/deactivate. On success every session is revoked server-side, so
 * we signOut() to clear the local cookie and land on /login.
 *
 * Presentation + wiring only; re-auth, session revocation, email, and audit
 * live in the route. Deactivated ≠ deleted — copy stresses reversibility.
 */

import { useState } from "react";
import { signOut } from "next-auth/react";
import { Loader2, UserX } from "lucide-react";

export function DeactivateAccountCard() {
  const [open,      setOpen]      = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!currentPw) return;
    setLoading(true);
    try {
      const res  = await fetch("/api/user/deactivate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ currentPassword: currentPw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't deactivate your account. Please try again.");
        setLoading(false);
        return;
      }
      // All sessions (including this one) are already revoked server-side —
      // signOut clears the local cookie and returns the user to /login.
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
        <UserX size={14} />
        Deactivate account
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
        </div>
      )}

      <div
        className="rounded-xl border px-3 py-2.5 text-xs"
        style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-muted)" }}
      >
        You&apos;ll be signed out everywhere and won&apos;t be able to use Fourth
        Meridian until you reactivate. Nothing is deleted — sign in again anytime
        and choose &quot;Reactivate&quot; to pick up exactly where you left off.
      </div>

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
          {loading ? <Loader2 size={14} className="animate-spin" /> : <UserX size={14} />}
          Deactivate my account
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setCurrentPw(""); setError(""); }}
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
