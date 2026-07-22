"use client";

/**
 * components/security/ChangeEmailForm.tsx  (OPS-2 S3a)
 *
 * Request-side change-email form for the Security Center. Collects the new
 * address + current password and posts to /api/user/email/request. On success
 * it tells the user to confirm from their new inbox — the swap happens later,
 * via the confirmation link (S3b). Presentation + wiring only; all validation,
 * re-auth, and emailing live in the route.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";

export function ChangeEmailForm({ currentEmail }: { currentEmail: string }) {
  const [newEmail,     setNewEmail]     = useState("");
  const [currentPw,    setCurrentPw]    = useState("");
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState("");
  const [done,         setDone]         = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!newEmail.trim() || !currentPw) return;
    setLoading(true);
    try {
      const res  = await fetch("/api/user/email/request", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ newEmail: newEmail.trim(), currentPassword: currentPw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Couldn't request the change. Please try again.");
        return;
      }
      setDone(true);
      setNewEmail("");
      setCurrentPw("");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400">
        Check your new inbox — we&apos;ve sent a link to confirm the change. Your
        email won&apos;t change until you confirm from the new address.
      </div>
    );
  }

  const inputClass =
    "w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors";

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-xs" style={{ color: "var(--text-faint)" }}>
        Current email: <span className="text-gray-300">{currentEmail}</span>
      </p>

      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <input
        type="email"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        required
        placeholder="New email address"
        autoComplete="email"
        className={inputClass}
      />
      <input
        type="password"
        value={currentPw}
        onChange={(e) => setCurrentPw(e.target.value)}
        required
        placeholder="Current password"
        autoComplete="current-password"
        className={inputClass}
      />

      <button
        type="submit"
        disabled={loading || !newEmail.trim() || !currentPw}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
      >
        {loading ? (<><Loader2 size={15} className="animate-spin" /> Sending…</>) : "Change Email"}
      </button>
    </form>
  );
}
