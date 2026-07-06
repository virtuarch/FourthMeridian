"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Loader2, ShieldCheck, ArrowLeft, Key } from "lucide-react";
import { AppLogo } from "@/components/ui/AppLogo";

// ── Step types ────────────────────────────────────────────────────────────────

type Step = "credentials" | "totp" | "recovery";

// ── Main form ─────────────────────────────────────────────────────────────────

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Step 1 state
  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");
  const [showPw,     setShowPw]     = useState(false);

  // Step 2 state
  const [totpCode,     setTotpCode]     = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  // UI state
  const [step,    setStep]    = useState<Step>("credentials");
  const [error,   setError]   = useState(() =>
    searchParams.get("error") ? "Invalid email, username, or password." : ""
  );
  const [notice,  setNotice]  = useState(() => {
    if (searchParams.get("registered") === "true") return "Account created! Sign in below.";
    if (searchParams.get("reset")      === "true") return "Password updated. Sign in with your new password.";
    return "";
  });
  const [loading, setLoading] = useState(false);

  // Verification resend (identifier-based) — uses the typed identifier. The
  // endpoint is non-enumerating, so we always show the same generic message.
  const [verifySending, setVerifySending] = useState(false);
  const [verifyMsg,     setVerifyMsg]     = useState("");

  const totpInputRef     = useRef<HTMLInputElement>(null);
  const recoveryInputRef = useRef<HTMLInputElement>(null);

  async function handleResendVerification() {
    if (verifySending) return;
    if (!identifier.trim()) {
      setVerifyMsg("Enter your email or username above first.");
      return;
    }
    setVerifySending(true);
    setVerifyMsg("");
    try {
      await fetch("/api/auth/verify-email/resend", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ identifier: identifier.toLowerCase().trim() }),
      });
      // Non-enumerating: identical message regardless of account state.
      setVerifyMsg("If your account needs verification, a new link has been sent.");
    } catch {
      setVerifyMsg("Couldn't send right now. Please try again.");
    } finally {
      setVerifySending(false);
    }
  }

  // Auto-focus TOTP input when step changes
  useEffect(() => {
    if (step === "totp")     setTimeout(() => totpInputRef.current?.focus(), 50);
    if (step === "recovery") setTimeout(() => recoveryInputRef.current?.focus(), 50);
  }, [step]);

  // ── Step 1: verify password + check if TOTP required ──────────────────────

  async function handleCredentialsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password) return;

    setError(""); setNotice(""); setLoading(true);

    try {
      const res  = await fetch("/api/auth/pre-login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ identifier: identifier.toLowerCase().trim(), password }),
      });
      const data = await res.json();

      if (!data.ok) {
        // Block mode (OPS-1 S2e): a correct password on an unverified account
        // returns reason:"unverified" — show a clear instruction and point at
        // the resend affordance below, rather than the generic error.
        setError(
          data.reason === "unverified"
            ? "Please verify your email before signing in. Check your inbox, or resend the verification email below."
            : "Invalid email, username, or password."
        );
        setPassword("");
        setLoading(false);
        return;
      }

      if (data.totpRequired) {
        // Show TOTP screen — identifier + password stay in state
        setStep("totp");
        setLoading(false);
        return;
      }

      // No TOTP — complete login directly
      await completeSignIn({ identifier, password });
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  // ── Step 2a: TOTP code ─────────────────────────────────────────────────────

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = totpCode.replace(/\s/g, "");
    if (code.length !== 6) return;

    setError(""); setLoading(true);
    await completeSignIn({ identifier, password, totpCode: code });
  }

  // ── Step 2b: Recovery code ─────────────────────────────────────────────────

  async function handleRecoverySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recoveryCode.trim()) return;

    setError(""); setLoading(true);
    await completeSignIn({ identifier, password, recoveryCode: recoveryCode.trim() });
  }

  // ── Shared: call NextAuth signIn ───────────────────────────────────────────

  async function completeSignIn(params: {
    identifier:   string;
    password:     string;
    totpCode?:    string;
    recoveryCode?: string;
  }) {
    const result = await signIn("credentials", {
      identifier:   params.identifier.toLowerCase().trim(),
      password:     params.password,
      totpCode:     params.totpCode     ?? "",
      recoveryCode: params.recoveryCode ?? "",
      redirect:     false,
    });

    setLoading(false);

    if (result?.error) {
      if (step === "totp") {
        setError("Incorrect code. Check your authenticator app.");
        setTotpCode("");
      } else if (step === "recovery") {
        setError("Recovery code is invalid or already used.");
        setRecoveryCode("");
      } else {
        setError("Invalid email, username, or password.");
        setPassword("");
      }
    } else {
      // Honour ?callbackUrl if present (e.g. middleware redirected here from a protected route).
      // Otherwise default to /dashboard/brief — the intended post-login landing.
      const callbackUrl = searchParams.get("callbackUrl");
      const dest = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/dashboard/brief";
      router.push(dest);
      router.refresh();
    }
  }

  function goBack() {
    setStep("credentials");
    setTotpCode("");
    setRecoveryCode("");
    setError("");
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Notice */}
      {notice && (
        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/30 px-4 py-3 text-sm text-emerald-400 text-center">
          {notice}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400 text-center">
          {error}
        </div>
      )}

      {/* ── Step 1: Credentials ────────────────────────────────────────────── */}
      {step === "credentials" && (
        <form onSubmit={handleCredentialsSubmit} className="space-y-3" suppressHydrationWarning>
          <div>
            <label className="block text-sm text-gray-400 mb-1.5">Email or username</label>
            <input
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              suppressHydrationWarning
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="Email or username"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-gray-400">Password</label>
              <Link href="/forgot-password" className="text-xs text-gray-500 hover:text-blue-400 transition-colors">
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                suppressHydrationWarning
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 pr-11 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors p-1"
                tabIndex={-1}
              >
                {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !identifier || !password}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2 mt-1"
          >
            {loading ? <><Loader2 size={15} className="animate-spin" /> Checking…</> : "Sign In"}
          </button>

          <div className="text-center pt-1">
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={verifySending}
              className="text-xs text-gray-500 hover:text-blue-400 transition-colors disabled:opacity-50"
            >
              {verifySending ? "Sending…" : "Didn't receive your verification email? Resend"}
            </button>
            {verifyMsg && <p className="text-xs text-gray-400 mt-1">{verifyMsg}</p>}
          </div>
        </form>
      )}

      {/* ── Step 2a: TOTP code ─────────────────────────────────────────────── */}
      {step === "totp" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-blue-500/5 border border-blue-500/20">
            <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <ShieldCheck size={18} className="text-blue-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Two-factor authentication</p>
              <p className="text-xs text-gray-400 mt-0.5">Open your authenticator app and enter the 6-digit code.</p>
            </div>
          </div>

          <form onSubmit={handleTotpSubmit} className="space-y-3" suppressHydrationWarning>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Authentication code</label>
              <input
                ref={totpInputRef}
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
                autoComplete="one-time-code"
                suppressHydrationWarning
                placeholder="000000"
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono tracking-widest text-center placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading || totpCode.length !== 6}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <><Loader2 size={15} className="animate-spin" /> Verifying…</> : "Verify"}
            </button>
          </form>

          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ArrowLeft size={12} /> Back
            </button>
            <button
              onClick={() => { setStep("recovery"); setError(""); setTotpCode(""); }}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >
              <Key size={12} /> Use a recovery code
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2b: Recovery code ─────────────────────────────────────────── */}
      {step === "recovery" && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/5 border border-amber-500/20">
            <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
              <Key size={18} className="text-amber-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-white">Recovery code</p>
              <p className="text-xs text-gray-400 mt-0.5">Each code can only be used once.</p>
            </div>
          </div>

          <form onSubmit={handleRecoverySubmit} className="space-y-3" suppressHydrationWarning>
            <div>
              <label className="block text-sm text-gray-400 mb-1.5">Recovery code</label>
              <input
                ref={recoveryInputRef}
                type="text"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.trim())}
                autoComplete="off"
                suppressHydrationWarning
                placeholder="XXXXXXXX-XXXXXXXX"
                className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-amber-500/50 transition-colors"
              />
            </div>

            <button
              type="submit"
              disabled={loading || !recoveryCode.trim()}
              className="w-full bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <><Loader2 size={15} className="animate-spin" /> Verifying…</> : "Use recovery code"}
            </button>
          </form>

          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              <ArrowLeft size={12} /> Back
            </button>
            <button
              onClick={() => { setStep("totp"); setError(""); setRecoveryCode(""); }}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >
              <ShieldCheck size={12} /> Use authenticator app
            </button>
          </div>
        </div>
      )}

      {/* Footer links — only show on credentials step */}
      {step === "credentials" && (
        <>
          <p className="text-center text-sm text-gray-500">
            New to Fourth Meridian?{" "}
            <Link href="/register" className="text-blue-400 hover:text-blue-300 transition-colors">
              Create an account
            </Link>
          </p>
          <p className="text-center text-xs text-gray-600">
            Secured with bcrypt · Sessions expire after 30 days
          </p>
        </>
      )}
    </>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="flex items-center justify-center mb-4">
            <AppLogo size={64} withWordmark wordmarkClassName="text-white text-2xl" forceTheme="dark" priority />
          </div>
          <p className="text-gray-400 text-sm mt-1">Sign in to your dashboard</p>
        </div>

        <Suspense fallback={<div className="text-gray-500 text-sm text-center">Loading…</div>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
