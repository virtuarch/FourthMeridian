/**
 * lib/auth/operator-2fa-prompt.ts  (owner D4, 2026-11-10 — operator 2FA UX)
 *
 * Pure, client-safe COPY and ROUTING for the 2FA prompts an operator sees.
 * UX only: nothing here admits or refuses anything. The authority stays where
 * it was — the shared Platform guard and the Platform pages' SEC-PLAT-1 checks
 * (lib/platform/authorize.ts, app/(shell)/dashboard/platform/*), gated by
 * env.isOperatorTotpEnforced. A client that ignores every value below still
 * meets those server checks on the next request.
 *
 *   • Audience — "operator" for anyone holding ANY active PlatformGrant, as the
 *     SERVER resolved it (lib/platform/directory.server.ts
 *     hasActivePlatformGrants, the same count that shows the Platform toggle).
 *     Never derived from a URL parameter or client state.
 *   • Notice copy — the notice rail's 2FA line. Ordinary users keep the exact
 *     prior wording ("recommended"); operators are told plainly it is required
 *     for the platform operator tools, and the action opens enrolment directly.
 *   • Required copy — the enrolment widget's "required" banner, per audience.
 *   • Toggle href — the Platform side of the header toggle. While the server
 *     says the viewer is an operator who must enrol (enforcement on, no TOTP),
 *     it opens the existing enrolment widget with a return path; otherwise it is
 *     the Platform directory, exactly as before.
 *   • Continue path — where enrolment returns to. Only a validated same-origin
 *     Platform path is accepted (lib/auth/return-to validateReturnTo + a
 *     Platform prefix); anything else ⇒ null (stay on Security settings).
 */

import { validateReturnTo } from "@/lib/auth/return-to";

export type TwoFactorAudience = "operator" | "user";

/** Server fact → audience. `isOperator` must come from the server's grant read. */
export function twoFactorAudience(isOperator: boolean): TwoFactorAudience {
  return isOperator === true ? "operator" : "user";
}

/** The Security settings page that hosts the existing enrolment widget. */
export const SECURITY_SETTINGS_HREF = "/dashboard/settings/security";
/** Opens the existing setup flow (QR + code form) on arrival, still cancellable. */
export const START_2FA_HREF = `${SECURITY_SETTINGS_HREF}?setup2fa=start`;
/** The Platform directory (lib/space-nav PLATFORM_DIRECTORY_HREF, restated to stay dependency-light). */
export const PLATFORM_HOME_HREF = "/dashboard/platform";

export const USER_2FA_NOTICE_TEXT = "Protect your account with 2FA.";
export const USER_2FA_NOTICE_ACTION = "Enable";
export const OPERATOR_2FA_NOTICE_TEXT = "2FA is required to use the platform operator tools.";
export const OPERATOR_2FA_NOTICE_ACTION = "Set up 2FA";

export interface TwoFactorNoticeCopy { title: string; actionLabel: string; href: string }

/** The notice rail's 2FA line for this audience. Users: unchanged copy + href. */
export function twoFactorNoticeCopy(audience: TwoFactorAudience): TwoFactorNoticeCopy {
  return audience === "operator"
    ? { title: OPERATOR_2FA_NOTICE_TEXT, actionLabel: OPERATOR_2FA_NOTICE_ACTION, href: START_2FA_HREF }
    : { title: USER_2FA_NOTICE_TEXT, actionLabel: USER_2FA_NOTICE_ACTION, href: SECURITY_SETTINGS_HREF };
}

export interface TwoFactorRequiredCopy { heading: string; body: string }

/** The enrolment widget's "required" banner (shown only in enforced mode). */
export function twoFactorRequiredCopy(audience: TwoFactorAudience): TwoFactorRequiredCopy {
  return audience === "operator"
    ? {
        heading: "Two-factor authentication is required",
        body: "2FA is required to use the platform operator tools. Set it up now to continue to Platform Spaces.",
      }
    : {
        heading: "Two-factor authentication is required",
        body: "Your organization requires 2FA. Set it up now to continue using Fourth Meridian.",
      };
}

/** Prefixes enrolment may return to (the Platform shell and the Merchant Ops page). */
const CONTINUE_PREFIXES = [PLATFORM_HOME_HREF, "/merchant-ops"] as const;

/**
 * A validated return path for after enrolment, or null. Same-origin path only
 * (validateReturnTo), and only inside the Platform surfaces — this is a
 * "continue where you were going" for operators, never a general redirect.
 */
export function safeOperatorContinuePath(raw: unknown): string | null {
  const ok = validateReturnTo(raw);
  if (!ok) return null;
  const path = ok.split(/[?#]/, 1)[0];
  return CONTINUE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`)) ? ok : null;
}

/** Enforced enrolment (the same `setup2fa=true` mode the server redirect uses) + a return path. */
export function operatorEnrolmentHref(next: string = PLATFORM_HOME_HREF): string {
  const safe = safeOperatorContinuePath(next) ?? PLATFORM_HOME_HREF;
  return `${SECURITY_SETTINGS_HREF}?setup2fa=true&next=${encodeURIComponent(safe)}`;
}

/**
 * The Platform side of the header toggle. `operatorTotpPending` is a SERVER
 * fact (layout: active grant AND enforcement on AND no TOTP, fail-quiet false).
 * False ⇒ the directory, exactly as before.
 */
export function platformToggleHref(operatorTotpPending: boolean): string {
  return operatorTotpPending === true ? operatorEnrolmentHref(PLATFORM_HOME_HREF) : PLATFORM_HOME_HREF;
}
