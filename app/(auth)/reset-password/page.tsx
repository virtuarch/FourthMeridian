"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { AuthCard, AuthHeader, AuthFooter, AuthButton, AuthStatus } from "@/components/auth";
import { Field, Input, PasswordField } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";

function ResetPasswordForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const token        = searchParams.get("token") ?? "";

  const [password,        setPassword]        = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error,           setError]           = useState("");
  const [loading,         setLoading]         = useState(false);
  const [success,         setSuccess]         = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!token) setError("Invalid or missing reset token. Please request a new link.");
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setLoading(true);

    const res  = await fetch("/api/auth/reset-password", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));

    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Reset failed. Please try again.");
      return;
    }

    setSuccess(true);
    setTimeout(() => router.push("/login?reset=true"), 2500);
  }

  if (success) {
    return (
      <AuthStatus tone="success" icon={ShieldCheck} title="Password updated successfully.">
        Redirecting you to sign in…
      </AuthStatus>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {error && <InlineBanner tone="error">{error}</InlineBanner>}

      <Field label="New password" htmlFor="rp-password">
        <PasswordField
          id="rp-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          disabled={!token}
          autoFocus
          placeholder="Min. 8 characters"
          autoComplete="new-password"
        />
      </Field>

      <Field label="Confirm password" htmlFor="rp-confirm">
        <Input
          id="rp-confirm"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
          disabled={!token}
          placeholder="Repeat new password"
          autoComplete="new-password"
        />
      </Field>

      <AuthButton type="submit" loading={loading} disabled={loading || !token || !password || !confirmPassword}>
        {loading ? "Updating…" : "Set New Password"}
      </AuthButton>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <AuthCard>
      <AuthHeader title="Set new password" subtitle="Choose a strong password for your account" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <ResetPasswordForm />
      </Suspense>

      <AuthFooter>
        <Link
          href="/login"
          className="text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        >
          Back to sign in
        </Link>
      </AuthFooter>
    </AuthCard>
  );
}
