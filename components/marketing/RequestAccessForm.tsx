"use client";

/**
 * components/marketing/RequestAccessForm.tsx
 *
 * The ONE client component in the landing page — the beta "Request access"
 * form. It needs client interactivity to submit, so it opts in; every other
 * marketing component stays server-only (see lib/marketing-boundary.test.ts).
 *
 * It posts to POST /api/access-request through lib/marketing/request-access.ts,
 * which is the entire dynamic seam of the landing page (investigation §3). That
 * endpoint is built by Wave 1② and may not have landed yet: on a 404 the
 * wrapper returns { status: "queued", degraded: true } and this form shows the
 * same success shell it would on a real submit — the form is never a dead end
 * during rollout.
 *
 * No CAPTCHA here (Wave 2⑥ owns it); the form still works unprotected until
 * that lands.
 */

import { useState } from "react";
import {
  submitAccessRequest,
  isProbablyEmail,
  type AccessRequestResult,
} from "@/lib/marketing/request-access";
import { REQUEST_ACCESS } from "@/content/marketing/copy";

type Status = "idle" | "submitting" | "success" | "error" | "rate_limited";

export function RequestAccessForm() {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting") return;
    if (!isProbablyEmail(email)) {
      setStatus("error");
      setMessage("Please enter a valid email address.");
      return;
    }

    setStatus("submitting");
    setMessage("");

    const result: AccessRequestResult = await submitAccessRequest({ email, note });

    if (result.status === "queued") {
      // Success — whether the endpoint accepted it or isn't live yet (degraded).
      setStatus("success");
      return;
    }
    if (result.status === "rate_limited") {
      setStatus("rate_limited");
      setMessage(result.message);
      return;
    }
    setStatus("error");
    setMessage(result.message);
  }

  if (status === "success") {
    return (
      <div
        className="rounded-2xl border p-6"
        style={{
          borderColor: "color-mix(in srgb, var(--emerald-500) 40%, transparent)",
          backgroundColor: "color-mix(in srgb, var(--emerald-500) 10%, transparent)",
        }}
      >
        <p className="text-base font-semibold" style={{ color: "var(--emerald-300)" }}>
          {REQUEST_ACCESS.successTitle}
        </p>
        <p className="mt-1.5 text-sm leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          {REQUEST_ACCESS.successBody}
        </p>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <label
          htmlFor="access-email"
          className="mb-1.5 block text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          Email address
        </label>
        <input
          id="access-email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="w-full rounded-xl border px-4 py-3 text-sm outline-none transition-colors"
          style={{
            backgroundColor: "var(--glass-ultrathin)",
            borderColor: "var(--border-hairline-strong)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      <div>
        <label
          htmlFor="access-note"
          className="mb-1.5 block text-sm"
          style={{ color: "var(--text-secondary)" }}
        >
          Anything you'd like us to know?{" "}
          <span style={{ color: "var(--text-muted)" }}>(optional)</span>
        </label>
        <textarea
          id="access-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="How you heard about us, what you're hoping to track, a security report…"
          className="w-full resize-y rounded-xl border px-4 py-3 text-sm outline-none transition-colors"
          style={{
            backgroundColor: "var(--glass-ultrathin)",
            borderColor: "var(--border-hairline-strong)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {(status === "error" || status === "rate_limited") && message && (
        <p
          className="rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: "color-mix(in srgb, var(--coral-500) 40%, transparent)",
            backgroundColor: "color-mix(in srgb, var(--coral-500) 10%, transparent)",
            color: "var(--coral-300)",
          }}
        >
          {message}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-xl px-5 py-3 text-sm font-semibold transition-colors disabled:opacity-60"
        style={{ backgroundColor: "var(--meridian-600)", color: "#fff" }}
      >
        {submitting ? "Submitting…" : "Request beta access"}
      </button>
    </form>
  );
}
