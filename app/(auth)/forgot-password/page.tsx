"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthCard, AuthHeader, AuthFooter, AuthButton } from "@/components/auth";
import { Field, Input } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";

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
    <AuthCard>
      <AuthHeader title="Reset your password" subtitle="Enter your email or username" />

      {error && <InlineBanner tone="error">{error}</InlineBanner>}

      {!submitted ? (
        <form onSubmit={handleSubmit} className="space-y-3">
          <Field label="Email or username" htmlFor="fp-identifier">
            <Input
              id="fp-identifier"
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
              placeholder="Email or username"
            />
          </Field>

          <AuthButton type="submit" loading={loading} disabled={loading || !identifier.trim()}>
            {loading ? "Sending…" : "Send Reset Link"}
          </AuthButton>
        </form>
      ) : (
        <div className="space-y-4">
          <InlineBanner tone="success">
            If an account exists for that email or username, a reset link has been sent.
          </InlineBanner>

          {/* DEV MODE: show reset link directly */}
          {resetUrl && (
            <div
              className="space-y-2 rounded-xl border px-4 py-3"
              style={{ background: "rgba(251,191,36,0.08)", borderColor: "rgba(251,191,36,0.26)" }}
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-warning)]">
                Dev mode — link visible in browser
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                In production this would be delivered by email.
              </p>
              <Link
                href={resetUrl}
                className="block break-all text-sm text-[var(--accent-info)] transition-colors hover:text-[var(--meridian-300)]"
              >
                {resetUrl}
              </Link>
            </div>
          )}
        </div>
      )}

      <AuthFooter>
        <Link
          href="/login"
          className="inline-flex items-center justify-center gap-1.5 text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          <ArrowLeft size={14} />
          Back to sign in
        </Link>
      </AuthFooter>
    </AuthCard>
  );
}
