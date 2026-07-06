"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { AppLogo } from "@/components/ui/AppLogo";

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
      <div className="rounded-xl bg-gray-900/60 border border-gray-800 px-4 py-4 text-center space-y-2">
        <Loader2 size={20} className="text-blue-400 mx-auto animate-spin" />
        <p className="text-sm text-gray-400">Confirming your new email…</p>
      </div>
    );
  }

  if (status === "changed") {
    return (
      <div className="space-y-4">
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-4 text-center space-y-1">
          <CheckCircle2 size={20} className="text-emerald-400 mx-auto" />
          <p className="text-sm text-emerald-400 font-medium">Your email address has been changed.</p>
          {newEmail && (
            <p className="text-xs text-gray-400">
              Sign in with your new email: <span className="text-gray-200">{newEmail}</span>
            </p>
          )}
          <p className="text-xs text-gray-500">For your security, all sessions were signed out.</p>
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
      <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-4 text-center space-y-1">
        <AlertCircle size={20} className="text-red-400 mx-auto" />
        <p className="text-sm text-red-400 font-medium">{heading}</p>
        <p className="text-xs text-gray-500">{message}</p>
      </div>
      <Link
        href="/login"
        className="block text-center text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        Back to sign in
      </Link>
    </div>
  );
}

export default function ConfirmEmailChangePage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center mb-4">
            <AppLogo size={32} withWordmark wordmarkClassName="text-white text-lg" forceTheme="dark" priority />
          </div>
          <h1 className="text-2xl font-bold text-white">Confirm email change</h1>
          <p className="text-gray-400 text-sm mt-1">Confirming your new email address</p>
        </div>

        <Suspense fallback={<div className="text-gray-500 text-sm text-center">Loading…</div>}>
          <ConfirmEmailChangeInner />
        </Suspense>
      </div>
    </div>
  );
}
