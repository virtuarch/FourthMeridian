"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { AuthCard, AuthHeader, AuthButton, AuthStatus } from "@/components/auth";

type ConfirmStatus =
  | "loading"
  | "changed"
  | "expired"
  | "email_taken"
  | "invalid";

function ConfirmEmailChangeInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  // Initial state derived from token presence so we never setState
  // synchronously inside the effect (missing token is "invalid" from the start).
  const [status,   setStatus]   = useState<ConfirmStatus>(() => (token ? "loading" : "invalid"));
  const [newEmail, setNewEmail] = useState<string>("");
  // Guard against React's double-effect (and email-client prefetch) firing the
  // POST twice — the change token is single-use.
  const submitted = useRef(false);

  useEffect(() => {
    if (submitted.current) return;
    submitted.current = true;

    if (!token) return; // already "invalid" from the initializer — nothing to fetch

    (async () => {
      try {
        const res  = await fetch("/api/user/email/confirm", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        const next = data?.status as ConfirmStatus | undefined;

        if (next === "changed" || next === "expired" || next === "email_taken" || next === "invalid") {
          if (typeof data?.newEmail === "string") setNewEmail(data.newEmail);
          setStatus(next);
        } else {
          setStatus("invalid");
        }
      } catch {
        setStatus("invalid");
      }
    })();
  }, [token]);

  if (status === "loading") {
    return (
      <AuthStatus tone="neutral" icon={Loader2} iconSpin title="Confirming your new email…" />
    );
  }

  if (status === "changed") {
    return (
      <div className="space-y-4">
        <AuthStatus tone="success" icon={CheckCircle2} title="Your email address has been changed.">
          {newEmail && (
            <>
              Sign in with your new email:{" "}
              <span className="text-[var(--text-secondary)]">{newEmail}</span>
              <br />
            </>
          )}
          For your security, all sessions were signed out.
        </AuthStatus>
        <AuthButton href="/login">Continue to Sign In</AuthButton>
      </div>
    );
  }

  // expired | email_taken | invalid — distinct messages, all route back to sign in.
  const heading =
    status === "expired"     ? "Link expired"
    : status === "email_taken" ? "Email unavailable"
    :                          "Invalid link";

  const message =
    status === "expired"
      ? "This confirmation link has expired. Sign in and request the email change again from Settings."
    : status === "email_taken"
      ? "That email address is no longer available. Sign in and try a different address from Settings."
      : "This confirmation link isn't valid. Check that you opened the full link from your email.";

  return (
    <div className="space-y-4">
      <AuthStatus tone="error" icon={AlertCircle} title={heading}>
        {message}
      </AuthStatus>
      <Link
        href="/login"
        className="block text-center text-sm text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
      >
        Back to sign in
      </Link>
    </div>
  );
}

export default function ConfirmEmailChangePage() {
  return (
    <AuthCard>
      <AuthHeader title="Confirm email change" subtitle="Confirming your new email address" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <ConfirmEmailChangeInner />
      </Suspense>
    </AuthCard>
  );
}
