"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthCard, AuthHeader, AuthFooter, AuthButton } from "@/components/auth";
import { Field, Input, Select, PasswordField } from "@/components/atlas/fields";
import { InlineBanner } from "@/components/atlas/InlineBanner";
import { TurnstileWidget } from "@/components/ui/TurnstileWidget";

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
  // CAPTCHA (Wave 2 ⑥) — only rendered when a site key is configured.
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [captchaNonce, setCaptchaNonce] = useState(0);

  function set(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

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

    router.push("/login?registered=true");
  }

  return (
    <>
      {error && <InlineBanner tone="error">{error}</InlineBanner>}

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

        <AuthButton
          type="submit"
          loading={loading}
          disabled={loading || !form.email || !form.username || !form.password || !form.firstName || !form.lastName}
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
