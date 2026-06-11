"use client";

import { useState, useEffect, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, Loader2 } from "lucide-react";

function LoginForm() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [identifier, setIdentifier] = useState("");
  const [password,   setPassword]   = useState("");
  const [showPw,     setShowPw]     = useState(false);
  const [error,      setError]      = useState("");
  const [notice,     setNotice]     = useState("");
  const [loading,    setLoading]    = useState(false);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const err = searchParams.get("error");
    if (err) setError("Invalid email, username, or password.");

    if (searchParams.get("registered") === "true") {
      setNotice("Account created! Sign in below.");
    }
    if (searchParams.get("reset") === "true") {
      setNotice("Password updated. Sign in with your new password.");
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [searchParams]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!identifier.trim() || !password) return;

    setError("");
    setNotice("");
    setLoading(true);

    const result = await signIn("credentials", {
      identifier: identifier.toLowerCase().trim(),
      password,
      redirect:   false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email, username, or password.");
      setPassword("");
    } else {
      router.push("/dashboard");
      router.refresh();
    }
  }

  return (
    <>
      {/* Notice (success) */}
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

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">Email or username</label>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="username"
            required
            autoFocus
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
            placeholder="Email or username"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm text-gray-400">Password</label>
            <Link
              href="/forgot-password"
              className="text-xs text-gray-500 hover:text-blue-400 transition-colors"
            >
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
          {loading ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Signing in…
            </>
          ) : (
            "Sign In"
          )}
        </button>
      </form>

      <p className="text-center text-sm text-gray-500">
        New to FinTracker?{" "}
        <Link href="/register" className="text-blue-400 hover:text-blue-300 transition-colors">
          Create an account
        </Link>
      </p>

      <p className="text-center text-xs text-gray-600">
        Secured with bcrypt · Sessions expire after 30 days
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">

        {/* Logo */}
        <div className="text-center">
          <img src="/logo-full.png" alt="FinTracker" className="h-[100px] w-auto object-contain mx-auto mb-4" />
          <p className="text-gray-400 text-sm mt-1">Sign in to your dashboard</p>
        </div>

        <Suspense fallback={<div className="text-gray-500 text-sm text-center">Loading…</div>}>
          <LoginForm />
        </Suspense>

      </div>
    </div>
  );
}
