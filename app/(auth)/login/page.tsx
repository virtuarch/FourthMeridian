"use client";

import { useState, useEffect, useRef, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ShieldCheck, ArrowLeft, Key } from "lucide-react";
import { AuthCard, AuthHeader, AuthFooter, AuthButton, AuthCallout } from "@/components/auth";
import { Field, Input, PasswordField, OtpInput } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";
import { TurnstileWidget } from "@/components/ui/TurnstileWidget";
import {
  classifyPreLoginResponse,
  classifySignInError,
  LOGIN_MESSAGES,
  AUTH_UNAVAILABLE_TOKEN,
} from "@/lib/auth/login-outcome";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

// ── Step types ────────────────────────────────────────────────────────────────

type Step = "credentials" | "totp" | "recovery";

// ── Main form ─────────────────────────────────────────────────────────────────

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  // Step 1 state
  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");

  // Step 2 state
  const [totpCode,     setTotpCode]     = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");

  // UI state
  const [step,    setStep]    = useState<Step>("credentials");
  // NextAuth redirect-error flow (pages.error → /login?error=…). We use
  // redirect:false everywhere below, so this is an edge path, but keep it
  // honest: an authority-unavailable sentinel must not read as invalid creds.
  const [error,   setError]   = useState(() => {
    const e = searchParams.get("error");
    if (!e) return "";
    return e.includes(AUTH_UNAVAILABLE_TOKEN) ? LOGIN_MESSAGES.unavailable : LOGIN_MESSAGES.invalid;
  });
  const [notice,  setNotice]  = useState(() => {
    if (searchParams.get("registered") === "true") return "Account created! Sign in below.";
    if (searchParams.get("reset")      === "true") return "Password updated. Sign in with your new password.";
    return "";
  });
  const [loading, setLoading] = useState(false);

  // CAPTCHA step-up (Wave 2 ⑥) — pre-login sets captchaRequired once this
  // identifier crosses the attempt threshold; the widget then renders on the
  // credentials step and its token is sent through signIn. Server-authoritative
  // (authorize() re-verifies) — these flags are UX only.
  const [captchaRequired, setCaptchaRequired] = useState(false);
  const [captchaToken,    setCaptchaToken]    = useState<string | null>(null);
  const [captchaNonce,    setCaptchaNonce]    = useState(0);

  // Verification resend (identifier-based) — uses the typed identifier. The
  // endpoint is non-enumerating, so we always show the same generic message.
  const [verifySending, setVerifySending] = useState(false);
  const [verifyMsg,     setVerifyMsg]     = useState("");

  // Reactivation (OPS-2 S4) — pre-login returned reason:"deactivated" after a
  // correct password. `reactivateOffer` shows the explicit "Reactivate and
  // sign in" affordance; `reactivateMode` is set ONLY by that button and adds
  // reactivate:"true" to the signIn credentials (never auto-set).
  const [reactivateOffer, setReactivateOffer] = useState<null | { totpRequired: boolean }>(null);
  const [reactivateMode,  setReactivateMode]  = useState(false);

  // Pending-deletion cancel (OPS-2 S7b) — pre-login returned reason:"pending_deletion"
  // after a correct password. Mirrors the reactivation affordance: the button
  // adds cancelDeletion:"true" to the signIn credentials (never auto-set); the
  // S7a authorize() leg clears the deletion timestamps after FULL auth.
  const [pendingDeletionOffer, setPendingDeletionOffer] = useState<null | { totpRequired: boolean }>(null);
  const [cancelDeletionMode,   setCancelDeletionMode]   = useState(false);

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
    setReactivateOffer(null); setReactivateMode(false);
    setPendingDeletionOffer(null); setCancelDeletionMode(false);

    try {
      const res  = await fetch("/api/auth/pre-login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ identifier: identifier.toLowerCase().trim(), password }),
      });
      const data = await res.json().catch(() => ({}));

      // PS-4A — classify by (HTTP status, body), NOT by `data.ok` alone. This is
      // the fix: an infrastructure response (503, or reason:"unavailable") and a
      // rate-limit response (429) are recognised BEFORE the generic bad-credentials
      // fallback, so neither is ever shown as invalid credentials.
      const decision = classifyPreLoginResponse(res.status, data);

      // Reflect the server's CAPTCHA step-up hint (present on ok + bad-creds
      // responses; absent on unavailable/rate-limited). Once true, the widget
      // renders on the credentials step.
      const decisionCaptcha =
        decision.kind === "continue" || decision.kind === "invalid" ? decision.captchaRequired : false;
      setCaptchaRequired(!!(TURNSTILE_SITE_KEY && decisionCaptcha));

      switch (decision.kind) {
        case "unavailable":
          // Infrastructure failure — truthful message, password kept so a retry
          // needs no re-typing.
          setError(LOGIN_MESSAGES.unavailable);
          setLoading(false);
          return;

        case "rate_limited":
          setError(LOGIN_MESSAGES.rateLimited);
          setLoading(false);
          return;

        case "pending_deletion":
          // A correct password on a pending-deletion account — offer explicit
          // cancellation (S7a cancelDeletion leg). Password KEPT in state.
          setPendingDeletionOffer({ totpRequired: decision.totpRequired });
          setLoading(false);
          return;

        case "deactivated":
          // A correct password on a deactivated account — offer reactivation.
          setReactivateOffer({ totpRequired: decision.totpRequired });
          setLoading(false);
          return;

        case "unverified":
          // Block mode (OPS-1 S2e): correct password, unverified email.
          setError(LOGIN_MESSAGES.unverified);
          setPassword("");
          setLoading(false);
          return;

        case "invalid":
          setError(LOGIN_MESSAGES.invalid);
          setPassword("");
          setLoading(false);
          return;

        case "continue":
          // Password accepted — advance the flow.
          // CAPTCHA step-up: if required and not yet solved, hold on the
          // credentials step and render the widget — solving it must happen
          // before we advance to TOTP or call signIn (authorize() re-verifies).
          if (TURNSTILE_SITE_KEY && decision.captchaRequired && !captchaToken) {
            setError("Please complete the verification below, then sign in again.");
            setLoading(false);
            return;
          }
          if (decision.totpRequired) {
            // Show TOTP screen — identifier + password stay in state
            setStep("totp");
            setLoading(false);
            return;
          }
          // No TOTP — complete login directly
          await completeSignIn({ identifier, password });
          return;
      }
    } catch {
      // Network/parse failure reaching pre-login — not a credential judgement.
      setError(LOGIN_MESSAGES.unavailable);
      setLoading(false);
    }
  }

  // ── Reactivate and sign in (OPS-2 S4) ──────────────────────────────────────
  // Explicit opt-in only. With 2FA enabled the flow routes through the normal
  // TOTP screen first — reactivation happens server-side only after FULL auth
  // succeeds (lib/auth.ts).

  async function handleReactivate() {
    if (!reactivateOffer) return;
    setError("");
    setReactivateMode(true);

    if (reactivateOffer.totpRequired) {
      setStep("totp");
      return;
    }

    setLoading(true);
    await completeSignIn({ identifier, password, reactivate: true });
  }

  // ── Cancel deletion and sign in (OPS-2 S7b) ────────────────────────────────
  // Explicit opt-in only. With 2FA enabled the flow routes through the normal
  // TOTP screen first — cancellation happens server-side only after FULL auth
  // succeeds (lib/auth.ts cancelDeletion leg).

  async function handleCancelDeletion() {
    if (!pendingDeletionOffer) return;
    setError("");
    setCancelDeletionMode(true);

    if (pendingDeletionOffer.totpRequired) {
      setStep("totp");
      return;
    }

    setLoading(true);
    await completeSignIn({ identifier, password, cancelDeletion: true });
  }

  // ── Step 2a: TOTP code ─────────────────────────────────────────────────────

  async function handleTotpSubmit(e: React.FormEvent) {
    e.preventDefault();
    const code = totpCode.replace(/\s/g, "");
    if (code.length !== 6) return;

    setError(""); setLoading(true);
    await completeSignIn({ identifier, password, totpCode: code, reactivate: reactivateMode, cancelDeletion: cancelDeletionMode });
  }

  // ── Step 2b: Recovery code ─────────────────────────────────────────────────

  async function handleRecoverySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recoveryCode.trim()) return;

    setError(""); setLoading(true);
    await completeSignIn({ identifier, password, recoveryCode: recoveryCode.trim(), reactivate: reactivateMode, cancelDeletion: cancelDeletionMode });
  }

  // ── Shared: call NextAuth signIn ───────────────────────────────────────────

  async function completeSignIn(params: {
    identifier:   string;
    password:     string;
    totpCode?:    string;
    recoveryCode?: string;
    reactivate?:  boolean;
    cancelDeletion?: boolean;
  }) {
    const result = await signIn("credentials", {
      identifier:   params.identifier.toLowerCase().trim(),
      password:     params.password,
      totpCode:     params.totpCode     ?? "",
      recoveryCode: params.recoveryCode ?? "",
      reactivate:   params.reactivate ? "true" : "",
      cancelDeletion: params.cancelDeletion ? "true" : "",
      // Wave 2 ⑥ — sent once past the step-up threshold; authorize() re-verifies.
      captchaToken: captchaToken ?? "",
      redirect:     false,
    });

    setLoading(false);

    if (result?.error) {
      // PS-4A — authorize() throws the AUTH_UNAVAILABLE_TOKEN sentinel when the
      // credential AUTHORITY is unreachable (vs returning null for a genuine
      // rejection). classifySignInError maps that to `unavailable`, never to the
      // credential/TOTP message. (See the NextAuth-limitation note in
      // lib/auth/login-outcome.ts: pre-login already catches the common case.)
      const kind = classifySignInError(result.error, step);
      if (kind === "unavailable") {
        setError(LOGIN_MESSAGES.unavailable);
        // Password kept — a retry needs no re-typing.
      } else if (kind === "totp_invalid") {
        setError(LOGIN_MESSAGES.totpInvalid);
        setTotpCode("");
      } else if (kind === "recovery_invalid") {
        setError(LOGIN_MESSAGES.recoveryInvalid);
        setRecoveryCode("");
      } else {
        setError(LOGIN_MESSAGES.invalid);
        setPassword("");
      }
      // Turnstile tokens are single-use — refresh the challenge before a retry.
      if (TURNSTILE_SITE_KEY && captchaRequired) {
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1);
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
    setReactivateMode(false);
    setCancelDeletionMode(false);
    // Deliberately keep reactivateOffer / pendingDeletionOffer — the panel
    // re-renders on the credentials step so the user can try again.
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Notice */}
      {notice && <InlineBanner tone="success">{notice}</InlineBanner>}

      {/* Error */}
      {error && <InlineBanner tone="error">{error}</InlineBanner>}

      {/* ── Reactivation offer (OPS-2 S4) ──────────────────────────────────── */}
      {step === "credentials" && reactivateOffer && (
        <AuthCallout
          tone="info"
          icon={ShieldCheck}
          title="This account is deactivated"
          action={
            <AuthButton onClick={handleReactivate} loading={loading} disabled={loading}>
              {loading ? "Reactivating…" : "Reactivate and sign in"}
            </AuthButton>
          }
        >
          Your data is intact. Reactivate to sign back in — everything will be
          exactly as you left it.
        </AuthCallout>
      )}

      {/* ── Pending-deletion cancel offer (OPS-2 S7b) ──────────────────────── */}
      {step === "credentials" && pendingDeletionOffer && (
        <AuthCallout
          tone="warning"
          icon={ShieldCheck}
          title="This account is scheduled for deletion"
          action={
            <AuthButton tone="warning" onClick={handleCancelDeletion} loading={loading} disabled={loading}>
              {loading ? "Cancelling…" : "Cancel deletion and sign in"}
            </AuthButton>
          }
        >
          Sign in to cancel the deletion — your data is still intact and
          everything will be restored exactly as you left it.
        </AuthCallout>
      )}

      {/* ── Step 1: Credentials ────────────────────────────────────────────── */}
      {step === "credentials" && (
        <form onSubmit={handleCredentialsSubmit} className="space-y-3" suppressHydrationWarning>
          <Field label="Email or username" htmlFor="login-identifier">
            <Input
              id="login-identifier"
              type="text"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              required
              autoFocus
              suppressHydrationWarning
              placeholder="Email or username"
            />
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <label htmlFor="login-password" className="text-xs text-[var(--text-muted)]">Password</label>
              <Link href="/forgot-password" className="text-xs text-[var(--text-faint)] transition-colors hover:text-[var(--accent-info)]">
                Forgot password?
              </Link>
            </div>
            <PasswordField
              id="login-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              suppressHydrationWarning
              placeholder="••••••••"
            />
          </div>

          {TURNSTILE_SITE_KEY && captchaRequired && (
            <div className="pt-1">
              <TurnstileWidget
                siteKey={TURNSTILE_SITE_KEY}
                onToken={setCaptchaToken}
                resetNonce={captchaNonce}
                theme="dark"
              />
            </div>
          )}

          <AuthButton
            type="submit"
            loading={loading}
            disabled={loading || !identifier || !password || (!!TURNSTILE_SITE_KEY && captchaRequired && !captchaToken)}
          >
            {loading ? "Checking…" : "Sign In"}
          </AuthButton>

          <div className="pt-1 text-center">
            <button
              type="button"
              onClick={handleResendVerification}
              disabled={verifySending}
              className="text-xs text-[var(--text-faint)] transition-colors hover:text-[var(--accent-info)] disabled:opacity-50"
            >
              {verifySending ? "Sending…" : "Didn't receive your verification email? Resend"}
            </button>
            {verifyMsg && <p className="mt-1 text-xs text-[var(--text-muted)]">{verifyMsg}</p>}
          </div>
        </form>
      )}

      {/* ── Step 2a: TOTP code ─────────────────────────────────────────────── */}
      {step === "totp" && (
        <div className="space-y-4">
          <AuthCallout tone="info" icon={ShieldCheck} title="Two-factor authentication">
            Open your authenticator app and enter the 6-digit code.
          </AuthCallout>

          <form onSubmit={handleTotpSubmit} className="space-y-3" suppressHydrationWarning>
            <Field label="Authentication code" htmlFor="login-totp">
              <OtpInput
                ref={totpInputRef}
                id="login-totp"
                value={totpCode}
                onChange={setTotpCode}
              />
            </Field>

            <AuthButton type="submit" loading={loading} disabled={loading || totpCode.length !== 6}>
              {loading ? "Verifying…" : "Verify"}
            </AuthButton>
          </form>

          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <ArrowLeft size={12} /> Back
            </button>
            <button
              onClick={() => { setStep("recovery"); setError(""); setTotpCode(""); }}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent-info)]"
            >
              <Key size={12} /> Use a recovery code
            </button>
          </div>
        </div>
      )}

      {/* ── Step 2b: Recovery code ─────────────────────────────────────────── */}
      {step === "recovery" && (
        <div className="space-y-4">
          <AuthCallout tone="warning" icon={Key} title="Recovery code">
            Each code can only be used once.
          </AuthCallout>

          <form onSubmit={handleRecoverySubmit} className="space-y-3" suppressHydrationWarning>
            <Field label="Recovery code" htmlFor="login-recovery">
              <Input
                ref={recoveryInputRef}
                id="login-recovery"
                type="text"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value.trim())}
                autoComplete="off"
                suppressHydrationWarning
                placeholder="XXXXXXXX-XXXXXXXX"
                className="font-mono"
              />
            </Field>

            <AuthButton tone="warning" type="submit" loading={loading} disabled={loading || !recoveryCode.trim()}>
              {loading ? "Verifying…" : "Use recovery code"}
            </AuthButton>
          </form>

          <div className="flex items-center justify-between">
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
            >
              <ArrowLeft size={12} /> Back
            </button>
            <button
              onClick={() => { setStep("totp"); setError(""); setRecoveryCode(""); }}
              className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--accent-info)]"
            >
              <ShieldCheck size={12} /> Use authenticator app
            </button>
          </div>
        </div>
      )}

      {/* Footer links — only show on credentials step */}
      {step === "credentials" && (
        <AuthFooter>
          <p className="text-sm text-[var(--text-muted)]">
            New to Fourth Meridian?{" "}
            <Link href="/register" className="text-[var(--accent-info)] transition-colors hover:text-[var(--meridian-300)]">
              Create an account
            </Link>
          </p>
          <p className="text-xs text-[var(--text-faint)]">
            Secured with bcrypt · Sessions expire after 30 days
          </p>
        </AuthFooter>
      )}
    </>
  );
}

export default function LoginPage() {
  return (
    <AuthCard>
      <AuthHeader title="Welcome back" subtitle="Sign in to your dashboard" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <LoginForm />
      </Suspense>
    </AuthCard>
  );
}
