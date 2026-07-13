"use client";

/**
 * components/dashboard/TotpNudgeBanner.tsx
 *
 * Dismissible encouragement banner (S8, §6.7) shown to logged-in users who
 * have not enabled TOTP. Purely informational — it does NOT enforce anything;
 * forced enrolment is a separate mechanism (the `requireTotpSetup` session
 * flag / proxy.ts redirect), which this component deliberately leaves alone.
 *
 * State source: reads `GET /api/user/totp/status` (already `requireUser`-gated,
 * returns `{ totpEnabled, totpConfigured, recoveryCodesRemaining }`). It does
 * NOT read the session JWT, which carries `requireTotpSetup` but not
 * `totpEnabled`. Renders nothing while the status is loading and nothing once
 * `totpEnabled` is true.
 *
 * Dismissal is per-browser in localStorage — re-appearing on a new device is
 * correct behavior for a nudge, not a bug. There is intentionally NO `User`
 * column for this (the plan rejects that as speculative schema).
 *
 * SYSTEM_ADMIN users are skipped entirely: they are already under a locked
 * forced-TOTP policy (`require_totp_system_admin`), so the nudge would be
 * redundant and confusing for them.
 */

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { ShieldAlert, X } from "lucide-react";

const DISMISS_KEY = "fm.totpNudge.dismissed";

export function TotpNudgeBanner() {
  const { data: session } = useSession();
  // Compare against the string literal rather than importing the Prisma
  // `UserRole` enum value — that would pull @prisma/client into the client
  // bundle. `session.user.role` is already typed as the UserRole union, so the
  // "SYSTEM_ADMIN" literal is type-checked against it.
  const isSystemAdmin = session?.user?.role === "SYSTEM_ADMIN";

  // `null` = still loading. Once resolved, holds the enabled flag.
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(true); // assume dismissed until localStorage read (avoids hydration flash)

  // Read per-browser dismissal on mount.
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false); // localStorage unavailable — treat as not dismissed
    }
  }, []);

  // Fetch TOTP status. Skip for SYSTEM_ADMIN (never rendered for them anyway).
  useEffect(() => {
    if (isSystemAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/user/totp/status");
        if (!res.ok) return; // stay silent on any error — this is a nudge, not critical UI
        const data = (await res.json()) as { totpEnabled?: boolean };
        if (!cancelled) setTotpEnabled(!!data.totpEnabled);
      } catch {
        /* network error — render nothing */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSystemAdmin]);

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore — dismissal simply won't persist */
    }
  }

  if (isSystemAdmin) return null;        // redundant for forced-TOTP admins
  if (dismissed) return null;            // per-browser dismissal
  if (totpEnabled === null) return null; // still loading status
  if (totpEnabled) return null;          // already protected

  return (
    <div className="mb-5 flex items-start gap-3 rounded-2xl border border-[var(--border-hairline-strong)] bg-[var(--surface-muted)] px-4 py-3">
      <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[var(--accent-warning)]" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--text-primary)] leading-snug">
          Add an extra layer of security
        </p>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)] leading-relaxed">
          Two-factor authentication protects your account even if your password
          is compromised.{" "}
          <Link
            href="/dashboard/settings/security"
            className="font-semibold text-[var(--text-primary)] underline underline-offset-2 hover:text-[var(--accent-warning)] transition-colors"
          >
            Enable 2FA
          </Link>
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 -mr-1 -mt-1 flex h-7 w-7 items-center justify-center rounded-xl text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)] transition-colors touch-manipulation"
      >
        <X size={15} />
      </button>
    </div>
  );
}
