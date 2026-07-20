"use client";

/**
 * components/admin/AdminTotpEnrollment.tsx
 *
 * PO-1A — the enrolment surface for a SYSTEM_ADMIN who has not yet completed
 * mandatory 2FA enrolment (PO-1). This is what /admin/security renders while
 * the session's phase is ENROLLING.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD: it composes NO gated admin data.
 * Every byte it renders comes from <TotpSection />, which talks only to
 * /api/user/totp/{status,setup,verify} — the sole endpoints a pending session
 * may reach. Nothing here fetches /api/admin/*, because a pending session is
 * 403'd there by design. Adding such a fetch would recreate the deadlock this
 * screen was built to remove, and lib/admin-totp-enrollment-surface.test.ts
 * fails the build if one appears.
 *
 * `enforced` is passed explicitly rather than left to the `setup2fa=true` query
 * param: the server already knows the phase, so the enrolment UI renders in its
 * non-dismissable mode even if the operator navigated here by hand or the param
 * was dropped in a redirect.
 *
 * On completion TotpSection clears `requireTotpSetup` from the JWT; the
 * router.refresh() below re-runs the server page, which now resolves ENROLLED
 * and swaps in the full console. Without that refresh the admin would sit on a
 * "you must enrol" screen having already enrolled — the same dead-end in a new
 * costume.
 */

import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { TotpSection } from "@/components/dashboard/TotpSection";

export function AdminTotpEnrollment() {
  const router = useRouter();

  return (
    <div className="max-w-2xl mx-auto px-4 py-10 space-y-6">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
          <ShieldAlert size={18} className="text-amber-400" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-white">
            Set up two-factor authentication
          </h1>
          <p className="text-sm text-gray-400 mt-1">
            Administrator accounts require 2FA. Until you finish enrolling, this
            is the only page available to you — platform settings, user
            management and security tooling stay locked.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-800 bg-gray-900/40 p-5">
        <TotpSection enforced onEnrolled={() => router.refresh()} />
      </div>

      <p className="text-xs text-gray-600">
        Lost access to your authenticator? Another SYSTEM_ADMIN can reset your
        2FA from this page. If you are the only administrator, recovery requires
        direct database access.
      </p>
    </div>
  );
}
