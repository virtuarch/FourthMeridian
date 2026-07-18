"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { AuthCard, AuthHeader, AuthButton, AuthStatus } from "@/components/auth";
import { InlineBanner } from "@/components/atlas/InlineBanner";

type VerifyStatus =
  | "loading"
  | "verified"
  | "already_verified"
  | "expired"
  | "invalid";

function VerifyEmailInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  // Initial state is derived from token presence so we never setState
  // synchronously inside the effect (a missing token is "invalid" from the
  // start; a present token starts "loading" until the POST resolves).
  const [status, setStatus] = useState<VerifyStatus>(() => (token ? "loading" : "invalid"));
  // Guard against React's double-effect (and email-client prefetch) firing the
  // POST twice — we consume the token exactly once per page load.
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;

    if (!token) return; // already "invalid" from the initializer — nothing to fetch

    (async () => {
      try {
        const res = await fetch("/api/auth/verify-email", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        const next = data?.status as VerifyStatus | undefined;

        if (next === "verified" || next === "already_verified" || next === "expired" || next === "invalid") {
          setStatus(next);
        } else {
          setStatus("invalid");
        }
      } catch {
        setStatus("invalid");
      }
    })();
  }, [token]);

  // ── Resend (token-based) — only reachable from the expired state ────────────
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function handleResend() {
    if (resendState === "sending" || resendState === "sent") return;
    setResendState("sending");
    try {
      const res  = await fetch("/api/auth/verify-email/resend", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.status === "sent") {
        setResendState("sent");
      } else if (data?.status === "already_verified") {
        setStatus("already_verified"); // flip the whole page to the verified state
      } else {
        setResendState("error");
      }
    } catch {
      setResendState("error");
    }
  }

  if (status === "loading") {
    return (
      <AuthStatus tone="neutral" icon={Loader2} iconSpin title="Verifying your email…" />
    );
  }

  if (status === "verified" || status === "already_verified") {
    const message =
      status === "verified"
        ? "Your email has been verified."
        : "Your email is already verified.";
    return (
      <div className="space-y-4">
        <AuthStatus tone="success" icon={CheckCircle2} title={message}>
          You can sign in to your account.
        </AuthStatus>
        <AuthButton href="/login">Continue to Sign In</AuthButton>
      </div>
    );
  }

  // expired | invalid — distinct messages, both route back to sign in.
  const errorMessage =
    status === "expired"
      ? "This verification link has expired. Please sign in to request a new one."
      : "This verification link isn't valid. Check that you opened the full link from your email.";

  return (
    <div className="space-y-4">
      <AuthStatus
        tone="error"
        icon={AlertCircle}
        title={status === "expired" ? "Link expired" : "Invalid link"}
      >
        {errorMessage}
      </AuthStatus>

      {/* Resend is only meaningful for an expired link (the token still maps to
          a user); an invalid token has no account to resend to. */}
      {status === "expired" && (
        resendState === "sent" ? (
          <InlineBanner tone="success">
            A new verification link has been sent — check your inbox.
          </InlineBanner>
        ) : (
          <div className="space-y-1">
            <AuthButton
              onClick={handleResend}
              loading={resendState === "sending"}
              disabled={resendState === "sending"}
            >
              {resendState === "sending" ? "Sending…" : "Resend verification email"}
            </AuthButton>
            {resendState === "error" && (
              <p className="text-center text-xs text-[var(--accent-negative)]">
                Couldn&apos;t send right now. Please try again.
              </p>
            )}
          </div>
        )
      )}

      <Link
        href="/login"
        className="block text-center text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        Back to sign in
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <AuthCard>
      <AuthHeader title="Email verification" subtitle="Confirming your email address" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <VerifyEmailInner />
      </Suspense>
    </AuthCard>
  );
}
