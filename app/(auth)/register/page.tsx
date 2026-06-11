"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Loader2 } from "lucide-react";

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

export default function RegisterPage() {
  const router = useRouter();

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

  const [showPw,      setShowPw]      = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error,       setError]       = useState("");
  const [loading,     setLoading]     = useState(false);

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
      return;
    }

    router.push("/login?registered=true");
  }

  const inputClass =
    "w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors";
  const labelClass = "block text-sm text-gray-400 mb-1.5";
  const selectClass =
    "w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition-colors appearance-none " +
    "text-white [&>option]:bg-gray-900";

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">

        {/* Logo */}
        <div className="text-center">
          <img src="/logo-full.png" alt="FinTracker" className="h-10 w-auto object-contain mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-white">Create your account</h1>
          <p className="text-gray-400 text-sm mt-1">Set up your personal finance dashboard</p>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400 text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">

          {/* ── Personal ── */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Personal</p>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>First name</label>
                  <input
                    type="text"
                    value={form.firstName}
                    onChange={(e) => set("firstName", e.target.value)}
                    required
                    className={inputClass}
                    placeholder="Jane"
                    autoComplete="given-name"
                  />
                </div>
                <div>
                  <label className={labelClass}>Last name</label>
                  <input
                    type="text"
                    value={form.lastName}
                    onChange={(e) => set("lastName", e.target.value)}
                    required
                    className={inputClass}
                    placeholder="Smith"
                    autoComplete="family-name"
                  />
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  Date of birth
                  <span className="text-gray-600 ml-1">(used for age-appropriate advice)</span>
                </label>
                <input
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(e) => set("dateOfBirth", e.target.value)}
                  className={inputClass + " [color-scheme:dark]"}
                  max={new Date().toISOString().split("T")[0]}
                />
              </div>

              <div>
                <label className={labelClass}>Employment status</label>
                <select
                  value={form.employmentStatus}
                  onChange={(e) => set("employmentStatus", e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select status…</option>
                  {EMPLOYMENT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelClass}>Primary reason for use</label>
                <select
                  value={form.useCase}
                  onChange={(e) => set("useCase", e.target.value)}
                  className={selectClass}
                >
                  <option value="">Select reason…</option>
                  {USE_CASE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className={labelClass}>
                  Credit score
                  <span className="text-gray-600 ml-1">(optional — you can add this later)</span>
                </label>
                <input
                  type="number"
                  value={form.creditScore}
                  onChange={(e) => set("creditScore", e.target.value)}
                  min={300}
                  max={850}
                  className={inputClass}
                  placeholder="e.g. 740"
                />
              </div>
            </div>
          </div>

          {/* ── Account ── */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Account</p>
            <div className="space-y-3">
              <div>
                <label className={labelClass}>Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => set("email", e.target.value)}
                  required
                  className={inputClass}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>

              <div>
                <label className={labelClass}>Username</label>
                <input
                  type="text"
                  value={form.username}
                  onChange={(e) => set("username", e.target.value)}
                  required
                  className={inputClass}
                  placeholder="e.g. janesmith"
                  autoComplete="username"
                  pattern="[a-zA-Z0-9_]{3,30}"
                  title="3–30 characters: letters, numbers, underscores"
                />
                <p className="text-xs text-gray-600 mt-1">3–30 characters. Letters, numbers, underscores.</p>
              </div>

              <div>
                <label className={labelClass}>Password</label>
                <div className="relative">
                  <input
                    type={showPw ? "text" : "password"}
                    value={form.password}
                    onChange={(e) => set("password", e.target.value)}
                    required
                    minLength={8}
                    className={inputClass + " pr-11"}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
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

              <div>
                <label className={labelClass}>Confirm password</label>
                <div className="relative">
                  <input
                    type={showConfirm ? "text" : "password"}
                    value={form.confirmPassword}
                    onChange={(e) => set("confirmPassword", e.target.value)}
                    required
                    className={inputClass + " pr-11"}
                    placeholder="Repeat password"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors p-1"
                    tabIndex={-1}
                  >
                    {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !form.email || !form.username || !form.password || !form.firstName || !form.lastName}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-3 rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Creating account…
              </>
            ) : (
              "Create Account"
            )}
          </button>
        </form>

        <p className="text-center text-sm text-gray-500">
          Already have an account?{" "}
          <Link href="/login" className="text-blue-400 hover:text-blue-300 transition-colors">
            Sign in
          </Link>
        </p>

        <p className="text-center text-xs text-gray-600">
          Secured with bcrypt · Date of birth encrypted at rest
        </p>
      </div>
    </div>
  );
}
