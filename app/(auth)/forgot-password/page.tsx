"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2, ArrowLeft } from "lucide-react";

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState("");
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [resetUrl,   setResetUrl]   = useState("");
  const [submitted,  setSubmitted]  = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim()) return;

    setError("");
    setLoading(true);

    const res  = await fetch("/api/auth/forgot-password", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ identifier: identifier.trim() }),
    });
    const data = await res.json().catch(() => ({}));

    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Something went wrong. Please try again.");
      return;
    }

    setSubmitted(true);
    if (data.resetUrl) setResetUrl(data.resetUrl);
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">

        {/* Logo */}
        <div className="text-center">
          <img src="/logo-full.png" alt="Fourth Meridian" className="h-10 w-auto object-contain mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">Reset your password</h1>
          <p className="text-gray-400 text-sm mt-1">Enter your email or username</p>
        </div>

        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        {!submitted ? (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Email or username</label>
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoFocus
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="Email or username"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !identifier.trim()}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Sending…
                </>
              ) : (
                "Send Reset Link"
              )}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 text-center">
              If an account exists for that email or username, a reset link has been sent.
            </div>

            {/* DEV MODE: show reset link directly */}
            {resetUrl && (
              <div className="rounded-xl bg-yellow-500/10 border border-yellow-500/30 px-4 py-3 space-y-2">
                <p className="text-xs font-semibold text-yellow-400 uppercase tracking-wider">
                  Dev mode — link visible in browser
                </p>
                <p className="text-xs text-gray-400">
                  In production this would be delivered by email.
                </p>
                <Link
                  href={resetUrl}
                  className="block text-sm text-blue-400 hover:text-blue-300 transition-colors break-all"
                >
                  {resetUrl}
                </Link>
              </div>
            )}
          </div>
        )}

        <Link
          href="/login"
          className="flex items-center justify-center gap-1.5 text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft size={14} />
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
