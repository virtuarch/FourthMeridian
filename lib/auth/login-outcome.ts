/**
 * lib/auth/login-outcome.ts  (PS-4A — authentication honesty)
 *
 * THE shared, framework-agnostic vocabulary for what a login attempt RESULTED
 * in, plus the pure classifiers the login UI uses to turn a server response
 * into a user-facing message.
 *
 * WHY THIS EXISTS
 * ---------------
 * The confirmed PS-3D defect: an infrastructure failure during login (a Prisma
 * pool timeout — P2024 / ECHECKOUTTIMEOUT) was caught and returned as the same
 * `{ ok: false }` shape as a wrong password, and the client mapped ANY
 * `!data.ok` to "Invalid email, username, or password." A database outage was
 * therefore shown to the user as invalid credentials, and — because the retry
 * later succeeded with the same password — provably so.
 *
 * The fix is a truthful internal vocabulary that the UI can stay deliberately
 * generic ABOUT (for enumeration safety) without LYING about. The security
 * posture is unchanged: the messages below never reveal whether an account
 * exists, whether the email or the password individually matched, or any
 * database/Prisma/Supavisor detail.
 *
 * These functions are PURE (no I/O, no server-only imports) so they run in the
 * browser bundle AND in unit tests, and are the single source of truth for the
 * mapping — the page consumes them; it does not re-implement the branching.
 */

// ── Internal outcome vocabulary (never rendered raw) ───────────────────────────

/**
 * What actually happened, distinguished internally. The UI collapses several of
 * these to one generic string on purpose; the point is that TEMPORARILY_UNAVAILABLE
 * and RATE_LIMITED are NEVER collapsed into INVALID_CREDENTIALS.
 */
export type AuthOutcome =
  | "INVALID_CREDENTIALS"      // identifier/password did not match (or user absent)
  | "AUTHENTICATION_CONTINUES" // password ok; a further step is required (TOTP, verify, reactivate…)
  | "TEMPORARILY_UNAVAILABLE"  // the credential authority (DB/pool/limiter) could not be reached
  | "RATE_LIMITED"             // too many attempts
  | "TOTP_REQUIRED"
  | "TOTP_INVALID";

/**
 * Sentinel thrown by NextAuth `authorize()` when the credential AUTHORITY is
 * unavailable (as opposed to credentials being rejected, which returns null).
 * It travels in NextAuth's `result.error` and is translated by the client to
 * the temporary-unavailability message — it is never rendered to the user.
 * Deliberately not a Prisma/DB detail.
 */
export const AUTH_UNAVAILABLE_TOKEN = "TEMPORARILY_UNAVAILABLE";

/** Body `reason` the pre-login route sends (with HTTP 503) on infrastructure failure. */
export const PRELOGIN_UNAVAILABLE_REASON = "unavailable";

// ── User-facing messages (deliberately generic; enumeration-safe) ──────────────

export const LOGIN_MESSAGES = {
  invalid:          "Invalid email, username, or password.",
  unavailable:      "Sign-in is temporarily unavailable. Please try again in a moment.",
  rateLimited:      "Too many attempts. Please wait a moment and try again.",
  unverified:       "Please verify your email before signing in. Check your inbox, or resend the verification email below.",
  totpInvalid:      "Incorrect code. Check your authenticator app.",
  recoveryInvalid:  "Recovery code is invalid or already used.",
} as const;

// ── Step-1 (pre-login) response classifier ─────────────────────────────────────

/**
 * How the login page should react to a pre-login response. `continue` means the
 * password was accepted and the flow advances (to TOTP, or straight to signIn);
 * every other value is a terminal message for this attempt.
 */
export type PreLoginDecision =
  | { kind: "continue"; totpRequired: boolean; captchaRequired: boolean }
  | { kind: "invalid";           captchaRequired: boolean }
  | { kind: "unavailable" }
  | { kind: "rate_limited" }
  | { kind: "unverified" }
  | { kind: "deactivated";       totpRequired: boolean }
  | { kind: "pending_deletion";  totpRequired: boolean }
  | { kind: "captcha_required" };

/**
 * Pure mapping from (HTTP status, parsed body) to a decision. This is the
 * fix's core: an infrastructure response (HTTP 503, or a body carrying
 * `reason: "unavailable"`) and a rate-limit response (HTTP 429) are classified
 * BEFORE the generic `!ok ⇒ invalid` fallback, so neither can ever surface as
 * invalid credentials.
 *
 * `body` is `unknown` because it is parsed JSON from the network; the function
 * reads only the fields it recognises and treats everything else as the generic
 * bad-credentials case.
 */
export function classifyPreLoginResponse(
  status: number,
  body: unknown,
): PreLoginDecision {
  const b = (body ?? {}) as {
    ok?: unknown;
    reason?: unknown;
    totpRequired?: unknown;
    captchaRequired?: unknown;
  };
  const captchaRequired = b.captchaRequired === true;
  const totpRequired    = b.totpRequired === true;

  // ── Infrastructure unavailable — checked FIRST, before any `ok` inspection.
  // Either the HTTP status says so (5xx) or the body explicitly says so. This is
  // the branch whose absence was the PS-3D defect.
  if (status >= 500 || b.reason === PRELOGIN_UNAVAILABLE_REASON) {
    return { kind: "unavailable" };
  }

  // ── Rate limited — the limiter returns 429; its body has no `ok`, so without
  // this branch it also fell through to "invalid".
  if (status === 429) {
    return { kind: "rate_limited" };
  }

  // ── Password accepted: advance the flow.
  if (b.ok === true) {
    return { kind: "continue", totpRequired, captchaRequired };
  }

  // ── Post-password gates (revealed only after a correct password upstream).
  if (b.reason === "unverified")        return { kind: "unverified" };
  if (b.reason === "pending_deletion")  return { kind: "pending_deletion", totpRequired };
  if (b.reason === "deactivated")       return { kind: "deactivated", totpRequired };

  // ── Generic bad credentials (the ONLY path to the invalid-credentials message).
  return { kind: "invalid", captchaRequired };
}

// ── Step-2 (NextAuth signIn) error classifier ──────────────────────────────────

/**
 * Translate a NextAuth `signIn(..., { redirect: false })` result.error into a
 * user-facing message class, given which step raised it. The load-bearing rule:
 * the authorize() authority-unavailable sentinel maps to `unavailable`, NOT to
 * the credential-rejection message.
 *
 * NOTE (NextAuth v4 limitation): whether a thrown error's message reaches
 * result.error verbatim is version-dependent. We match the sentinel defensively
 * (exact or substring). If a future NextAuth normalises the message to a
 * generic token, this degrades to the credential message for the STEP-2 path
 * only — step 1 (pre-login) already classifies the same infrastructure failure
 * correctly, so the user still sees the truthful message in the common case.
 */
export type SignInMessageKind = "unavailable" | "totp_invalid" | "recovery_invalid" | "invalid";

export function classifySignInError(
  error: string | null | undefined,
  step: "credentials" | "totp" | "recovery",
): SignInMessageKind {
  if (typeof error === "string" && error.includes(AUTH_UNAVAILABLE_TOKEN)) {
    return "unavailable";
  }
  if (step === "totp")     return "totp_invalid";
  if (step === "recovery") return "recovery_invalid";
  return "invalid";
}
