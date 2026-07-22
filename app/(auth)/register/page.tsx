"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard, AuthHeader, AuthFooter, AuthButton } from "@/components/auth";
import { Field, Input, Select, PasswordField } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";
import { TurnstileWidget } from "@/components/ui/TurnstileWidget";
import type { RegistrationPolicyResponse } from "@/app/api/registration-policy/route";

const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const EMPLOYMENT_OPTIONS = [
  { value: "EMPLOYED",      label: "Employed" },
  { value: "UNEMPLOYED",    label: "Unemployed" },
  { value: "SELF_EMPLOYED", label: "Self-employed" },
  { value: "STUDENT",       label: "Student" },
  { value: "RETIRED",       label: "Retired" },
];

const USE_CASE_OPTIONS = [
  { value: "PERSONAL_TRACKING", label: "Personal budget & net worth tracking" },
  { value: "BUSINESS_VENTURES", label: "Business / LLC financial oversight" },
  { value: "INVESTING",         label: "Portfolio & market focus" },
  { value: "DEBT_MANAGEMENT",   label: "Debt payoff planning" },
  { value: "OTHER",             label: "Other" },
];

function RegisterForm() {
  const router = useRouter();
  // Beta-invite deep link (buildBetaInviteUrl → /register?invite=<token>). When
  // present it is forwarded to the register API as `inviteToken`; the API only
  // consumes it in invite_only mode. Absent → normal open-registration flow.
  const inviteToken = useSearchParams().get("invite") ?? "";

  const [form, setForm] = useState({
    firstName:        "",
    lastName:         "",
    username:         "",
    email:            "",
    dateOfBirth:      "",
    employmentStatus: "",
    useCase:          "",
    creditScore:      "",
    password:         "",
    confirmPassword:  "",
  });

  const [error,       setError]       = useState("");
  const [loading,     setLoading]     = useState(false);
  // CONN-1 — post-success "check your inbox" state for uninvited signups. Holds
  // the address we sent the verification link to. Kept in component state (never
  // a URL param) so the email is not exposed in the address bar / history.
  const [sentTo,      setSentTo]      = useState<string | null>(null);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">("idle");
  // CAPTCHA (Wave 2 ⑥) — only rendered when a site key is configured.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);
  // PO-5A — required Terms/Privacy consent.
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  // PO-3C — the register form honors the authoritative registration policy: it is
  // not shown until the mode (+ any invite) is resolved. invite_only without a
  // valid invite ⇒ steer to request-access; closed ⇒ registration unavailable.
  const [policy, setPolicy]             = useState<RegistrationPolicyResponse | null>(null);
  const [policyLoading, setPolicyLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/registration-policy", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ invite: inviteToken || undefined }),
        });
        const p = (await r.json()) as RegistrationPolicyResponse;
        if (!alive) return;
        setPolicy(p);
        // Lock the email to the invited address so a mismatch can't even be typed.
        if (p.invitedEmail) setForm((f) => ({ ...f, email: p.invitedEmail as string }));
      } catch {
        // Fail OPEN to the form — the register API still enforces the mode
        // authoritatively, so a policy-fetch failure never bypasses the gate.
        if (alive) setPolicy({ mode: "open", canRegister: true, invitedEmail: null, requiresInvite: false });
      } finally {
        if (alive) setPolicyLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [inviteToken]);

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  const emailLocked = !!policy?.invitedEmail;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError("Please complete the verification below.");
      return;
    }
    if (!agreedToTerms) {
      setError("Please accept the Terms of Service and Privacy Policy to continue.");
      return;
    }

    setLoading(true);

    const payload: Record<string, unknown> = {
      email:            form.email.trim(),
      username:         form.username.trim(),
      password:         form.password,
      firstName:        form.firstName.trim(),
      lastName:         form.lastName.trim(),
      dateOfBirth:      form.dateOfBirth     || undefined,
      employmentStatus: form.employmentStatus || undefined,
      useCase:          form.useCase         || undefined,
      creditScore:      form.creditScore ? parseInt(form.creditScore) : undefined,
      inviteToken:      inviteToken || undefined,
      captchaToken:     captchaToken || undefined,
      acceptedTerms:    agreedToTerms,
    };

    const res = await fetch("/api/auth/register", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    setLoading(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? "Registration failed. Please try again.");
      // Turnstile tokens are single-use — refresh the challenge before a retry.
      if (TURNSTILE_SITE_KEY) {
        setCaptchaToken(null);
        setCaptchaNonce((n) => n + 1);
      }
      return;
    }

    // CONN-1 — honor the server's authoritative signal. An uninvited signup is
    // created UNVERIFIED and login is blocked until verified, so sending them to
    // the sign-in page (as before) was a dead-end. Show a "check your inbox"
    // screen instead. Invited signups are pre-verified → straight to sign-in.
    const data = await res.json().catch(() => ({}));
    if (data.verificationRequired) {
      setSentTo(form.email.trim());
      return;
    }
    router.push("/login?registered=true");
  }

  async function handleResend() {
    if (!sentTo || resendState === "sending") return;
    setResendState("sending");
    // Identifier-based resend is non-enumerating (always a generic 200), so the
    // UI shows the same confirmation regardless of outcome — no account-existence
    // signal. Rate limited server-side.
    await fetch("/api/auth/verify-email/resend", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ identifier: sentTo }),
    }).catch(() => {});
    setResendState("sent");
  }

  // ── CONN-1: post-success "check your inbox" (uninvited signups) ─────────────
  // Reached only after a 201 with verificationRequired. The account exists but
  // login is blocked until the emailed link is clicked — so this screen is the
  // truthful next step, not the sign-in page.
  if (sentTo) {
    return (
      <div className="space-y-5 text-center">
        <InlineBanner tone="success">
          Account created. Check your inbox to finish setting up.
        </InlineBanner>
        <p className="text-sm text-[var(--text-secondary)]">
          We sent a verification link to <span className="font-semibold text-[var(--text-primary)]">{sentTo}</span>.
          Click it to activate your account, then sign in. The link expires in about an hour.
        </p>
        <p className="text-xs text-[var(--text-muted)]">
          Didn&rsquo;t get it? Check spam, or resend below.
        </p>
        <div className="space-y-3">
          <AuthButton
            type="button"
            onClick={handleResend}
            loading={resendState === "sending"}
            disabled={resendState !== "idle"}
          >
            {resendState === "sent"
              ? "Verification email sent"
              : resendState === "sending"
                ? "Sending…"
                : "Resend verification email"}
          </AuthButton>
          <p className="text-sm text-[var(--text-muted)]">
            <Link
              href="/login"
              className="text-[var(--accent-info)] transition-colors hover:text-[var(--meridian-300)]"
            >
              Back to sign in
            </Link>
          </p>
        </div>
      </div>
    );
  }

  // ── Policy gating (PO-3C) ───────────────────────────────────────────────────
  if (policyLoading) {
    return <p className="text-center text-sm text-[var(--text-muted)]">Checking registration…</p>;
  }
  if (policy && !policy.canRegister) {
    const closed = policy.mode === "closed";
    return (
      <div className="space-y-4 text-center">
        <InlineBanner tone={closed ? "error" : "info"}>
          {closed
            ? "Registration is currently closed."
            : "Fourth Meridian is invite-only right now. You need an invitation to create an account."}
        </InlineBanner>
        <p className="text-sm text-[var(--text-muted)]">
          {closed
            ? "We’re not accepting new accounts at the moment."
            : "Have an invite? Open the link from your email. Otherwise, request access and we’ll reach out when a spot opens."}
        </p>
        <AuthButton href="/request-access" tone={closed ? "warning" : "primary"}>
          Request access
        </AuthButton>
      </div>
    );
  }

  return (
    <>
      {error && <InlineBanner tone="error">{error}</InlineBanner>}
      {emailLocked && (
        <InlineBanner tone="info">
          You&rsquo;re registering with your invited email — it&rsquo;s locked to match your invitation.
        </InlineBanner>
      )}

      <form onSubmit={handleSubmit} className="space-y-5" suppressHydrationWarning>

        {/* ── Personal ── */}
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Personal</p>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="First name" htmlFor="reg-first">
                <Input
                  id="reg-first"
                  type="text"
                  value={form.firstName}
                  onChange={(e) => set("firstName", e.target.value)}
                  required
                  placeholder="Jane"
                  autoComplete="given-name"
                />
              </Field>
              <Field label="Last name" htmlFor="reg-last">
                <Input
                  id="reg-last"
                  type="text"
                  value={form.lastName}
                  onChange={(e) => set("lastName", e.target.value)}
                  required
                  placeholder="Smith"
                  autoComplete="family-name"
                />
              </Field>
            </div>

            <Field label="Date of birth" htmlFor="reg-dob" help="Used for age-appropriate advice.">
              <Input
                id="reg-dob"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => set("dateOfBirth", e.target.value)}
                max={new Date().toISOString().split("T")[0]}
              />
            </Field>

            <Field label="Employment status" htmlFor="reg-employment">
              <Select
                id="reg-employment"
                value={form.employmentStatus}
                onChange={(e) => set("employmentStatus", e.target.value)}
                options={EMPLOYMENT_OPTIONS}
                placeholder="Select status…"
              />
            </Field>

            <Field label="Primary reason for use" htmlFor="reg-usecase">
              <Select
                id="reg-usecase"
                value={form.useCase}
                onChange={(e) => set("useCase", e.target.value)}
                options={USE_CASE_OPTIONS}
                placeholder="Select reason…"
              />
            </Field>

            <Field label="Credit score" htmlFor="reg-credit" help="Optional — you can add this later.">
              <Input
                id="reg-credit"
                type="number"
                value={form.creditScore}
                onChange={(e) => set("creditScore", e.target.value)}
                min={300}
                max={850}
                placeholder="e.g. 740"
              />
            </Field>
          </div>
        </div>

        {/* ── Account ── */}
        <div>
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">Account</p>
          <div className="space-y-3">
            <Field label="Email" htmlFor="reg-email">
              <Input
                id="reg-email"
                type="email"
                value={form.email}
                onChange={(e) => set("email", e.target.value)}
                required
                readOnly={emailLocked}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </Field>

            <Field label="Username" htmlFor="reg-username" help="3–30 characters. Letters, numbers, underscores.">
              <Input
                id="reg-username"
                type="text"
                value={form.username}
                onChange={(e) => set("username", e.target.value)}
                required
                placeholder="e.g. janesmith"
                autoComplete="username"
                pattern="[a-zA-Z0-9_]{3,30}"
                title="3–30 characters: letters, numbers, underscores"
              />
            </Field>

            <Field label="Password" htmlFor="reg-password">
              <PasswordField
                id="reg-password"
                value={form.password}
                onChange={(e) => set("password", e.target.value)}
                required
                minLength={8}
                placeholder="Min. 8 characters"
                autoComplete="new-password"
              />
            </Field>

            <Field label="Confirm password" htmlFor="reg-confirm">
              <PasswordField
                id="reg-confirm"
                value={form.confirmPassword}
                onChange={(e) => set("confirmPassword", e.target.value)}
                required
                placeholder="Repeat password"
                autoComplete="new-password"
              />
            </Field>
          </div>
        </div>

        {TURNSTILE_SITE_KEY && (
          <TurnstileWidget
            siteKey={TURNSTILE_SITE_KEY}
            onToken={setCaptchaToken}
            resetNonce={captchaNonce}
            theme="dark"
          />
        )}

        {/* PO-5A — required Terms/Privacy consent. */}
        <label className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={agreedToTerms}
            onChange={(e) => setAgreedToTerms(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--meridian-500)]"
            aria-label="Accept the Terms of Service and Privacy Policy"
          />
          <span>
            I agree to the{" "}
            <Link href="/terms" target="_blank" className="text-[var(--accent-info)] hover:text-[var(--meridian-300)]">Terms of Service</Link>
            {" "}and{" "}
            <Link href="/privacy" target="_blank" className="text-[var(--accent-info)] hover:text-[var(--meridian-300)]">Privacy Policy</Link>.
          </span>
        </label>

        <AuthButton
          type="submit"
          loading={loading}
          disabled={loading || !agreedToTerms || !form.email || !form.username || !form.password || !form.firstName || !form.lastName}
        >
          {loading ? "Creating account…" : "Create Account"}
        </AuthButton>
      </form>
    </>
  );
}

// useSearchParams() must sit under a Suspense boundary (Next app router), same
// pattern as the reset-password page.
export default function RegisterPage() {
  return (
    <AuthCard width="md">
      <AuthHeader title="Create your account" subtitle="Set up your personal finance dashboard" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <RegisterForm />
      </Suspense>

      <AuthFooter>
        <p className="text-sm text-[var(--text-muted)]">
          Already have an account?{" "}
          <Link href="/login" className="text-[var(--accent-info)] transition-colors hover:text-[var(--meridian-300)]">
            Sign in
          </Link>
        </p>
        <p className="text-xs text-[var(--text-faint)]">
          Secured with bcrypt · Date of birth encrypted at rest
        </p>
      </AuthFooter>
    </AuthCard>
  );
}
