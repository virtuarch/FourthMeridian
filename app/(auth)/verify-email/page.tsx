"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { AppLogo } from "@/components/ui/AppLogo";

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
      <div className="rounded-xl bg-gray-900/60 border border-gray-800 px-4 py-4 text-center space-y-2">
        <Loader2 size={20} className="text-blue-400 mx-auto animate-spin" />
        <p className="text-sm text-gray-400">Verifying your email…</p>
      </div>
    );
  }

  if (status === "verified" || status === "already_verified") {
    const message =
      status === "verified"
        ? "Your email has been verified."
        : "Your email is already verified.";
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-4 text-center space-y-1">
          <CheckCircle2 size={20} className="text-emerald-400 mx-auto" />
          <p className="text-sm text-emerald-400 font-medium">{message}</p>
          <p className="text-xs text-gray-500">You can sign in to your account.</p>
        </div>
        <Link
          href="/login"
          className="block w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold py-3 rounded-xl transition-colors text-center"
        >
          Continue to Sign In
        </Link>
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
      <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-4 text-center space-y-1">
        <AlertCircle size={20} className="text-red-400 mx-auto" />
        <p className="text-sm text-red-400 font-medium">
          {status === "expired" ? "Link expired" : "Invalid link"}
        </p>
        <p className="text-xs text-gray-500">{errorMessage}</p>
      </div>

      {/* Resend is only meaningful for an expired link (the token still maps to
          a user); an invalid token has no account to resend to. */}
      {status === "expired" && (
        resendState === "sent" ? (
          <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 text-center">
            A new verification link has been sent — check your inbox.
          </div>
        ) : (
          <div className="space-y-1">
            <button
              type="button"
              onClick={handleResend}
              disabled={resendState === "sending"}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {resendState === "sending" ? (
                <><Loader2 size={15} className="animate-spin" /> Sending…</>
              ) : (
                "Resend verification email"
              )}
            </button>
            {resendState === "error" && (
              <p className="text-xs text-red-400 text-center">Couldn&apos;t send right now. Please try again.</p>
            )}
          </div>
        )
      )}

      <Link
        href="/login"
        className="block text-center text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        Back to sign in
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="min-h-[100svh] bg-gray-950 flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center mb-4">
            <AppLogo size={32} withWordmark wordmarkClassName="text-white text-lg" forceTheme="dark" priority />
          </div>
          <h1 className="text-2xl font-bold text-white">Email verification</h1>
          <p className="text-gray-400 text-sm mt-1">Confirming your email address</p>
        </div>

        <Suspense fallback={<div className="text-gray-500 text-sm text-center">Loading…</div>}>
          <VerifyEmailInner />
        </Suspense>
      </div>
    </div>
  );
}
