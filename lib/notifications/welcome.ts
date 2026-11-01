/**
 * lib/notifications/welcome.ts  (owner-approved 2026-10-31)
 *
 * The ONE-TIME welcome: an in-app notice (ACCOUNT_WELCOME) plus the dedicated
 * `welcome` email. Exactly once per account, at the moment the account becomes
 * usable:
 *
 *   invited signup    app/api/auth/register/route.ts — after the account commits.
 *                     It is created PRE-VERIFIED (the beta invite proved the
 *                     inbox), so no verification email exists to collide with.
 *   uninvited signup  app/api/auth/verify-email/route.ts — after the FIRST
 *                     successful verification. Registration sends ONLY the
 *                     verification email; welcoming before the address is
 *                     proven would mail an unverified inbox and put two emails
 *                     side by side. A repeat click answers "already_verified"
 *                     before reaching here.
 *
 * IDEMPOTENT: the in-app row's dedupe key "ACCOUNT_WELCOME:user:{userId}:once"
 * is held for good (registry dedupeNeverReleases — dismissing the notice never
 * frees it), enforced by the (userId, dedupeKey) unique index, race-safe. The
 * email ships ONLY when createNotification CREATED that row: a second trigger
 * (a concurrent double-click on the verify link, a retried request) is
 * "suppressed" and sends nothing.
 *
 * CLASSIFICATION (catalog ACCOUNT_WELCOME): consent SERVICE. Not CEREMONY —
 * holding it back breaks no flow the user started (the F12 test) — and not
 * MARKETING. Not preference-suppressible (the type is locked per type), but its
 * email is storm-limited like every SERVICE email (lib/email/send.ts): a brand-
 * new account has nothing else in its storm window, and the verification email
 * before it is CEREMONY (exempt, never counted).
 *
 * ONE-SHOT, BY DESIGN (no retry, no duplicates). If the in-app anchor cannot
 * be written (createNotification "error"), nothing is sent and nothing retries;
 * if the email is held by the storm limit (RATE_LIMITED / RATE_LIMIT_UNVERIFIED)
 * or fails, the anchor already exists, so a later trigger is "duplicate". In
 * both cases this account's welcome is LOST for good. That is the deliberate
 * trade: a missed welcome is harmless, a second one is not.
 *
 * WHY THE ":once" KEY STAYS ONCE. Retention (lib/notifications/cleanup.ts)
 * deletes an archived row after the type's deleteDays (90 d), which frees the
 * key. That is safe only because NOTHING can trigger a welcome again:
 *   - sendWelcome is called from exactly two places — the register route
 *     (invited signups) and the verify-email route (a FIRST verification) —
 *     pinned by lib/notifications/new-notifications.test.ts;
 *   - the verify route welcomes only on the null → set transition of
 *     emailVerifiedAt, and nothing ever resets emailVerifiedAt to null;
 *   - email change (app/api/user/email/confirm) does NOT call sendWelcome.
 * Any change to those three facts (a new caller, an emailVerifiedAt reset, a
 * welcome on email change) must first give the welcome a durable marker.
 *
 * Best-effort and NON-THROWING: registration / verification already succeeded.
 */

import "server-only";
import { createNotification } from "@/lib/notifications/create";
import { sendEmail as chokepointSendEmail, type SendEmailFn } from "@/lib/email/send";
import { buildAppLink } from "@/lib/email/app-link";

export interface WelcomeRecipient {
  userId: string;
  email: string;
  firstName?: string | null;
}

export interface WelcomeDeps {
  create?: typeof createNotification;
  /** The email chokepoint (tests inject one built by createEmailSender with a ledger). */
  send?: SendEmailFn;
  /** The trusted app base (env.NEXT_PUBLIC_APP_URL). */
  appUrl?: string;
}

export type WelcomeOutcome = "sent" | "duplicate" | "not_sent" | "error";

/** Welcome a new account once. Never throws. */
export async function sendWelcome(user: WelcomeRecipient, deps: WelcomeDeps = {}): Promise<WelcomeOutcome> {
  // Named `sendEmail` on purpose: the catalog tests grep every sendEmail("…") site and its ledger key.
  const sendEmail = deps.send ?? chokepointSendEmail;
  try {
    const created = await (deps.create ?? createNotification)({ type: "ACCOUNT_WELCOME", userId: user.userId });
    // "suppressed": this account was already welcomed. "error": the anchor could
    // not be written — no email either, so a retry can never double-send.
    if (created.status === "suppressed") return "duplicate";
    if (created.status !== "created") return "error";

    const dashboardUrl = buildAppLink(deps.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "", "/dashboard");
    const result = await sendEmail("welcome", user.email, { firstName: user.firstName ?? null, dashboardUrl },
      { key: "ACCOUNT_WELCOME", recipientUserId: user.userId, ...(created.id ? { notificationId: created.id } : {}) });
    if (result.status === "error") {
      console.warn("[welcome] welcome email failed to send (non-fatal):", result.error);
      return "error";
    }
    return result.status === "sent" || result.status === "captured" ? "sent" : "not_sent";
  } catch (err) {
    console.warn(`[welcome] welcome failed (non-fatal): ${err instanceof Error ? err.name : typeof err}`);
    return "error";
  }
}
