/**
 * lib/email/app-link.ts
 *
 * Absolute in-app links for email CTAs that carry NO token (account security,
 * connections, notification settings). Same rule as reset-url.ts: `base` MUST be
 * the trusted env.NEXT_PUBLIC_APP_URL, never a request Host header. The result
 * is validated as an absolute http(s) URL, so a misconfigured base fails here
 * (and the sendEmail render guard turns that into an error result) instead of
 * emitting a relative or `javascript:` link.
 *
 * Every path below is a real page (app/(shell)/dashboard/...).
 */

import { safeHttpUrl } from "@/lib/email/design/escape";

export const APP_PATHS = {
  /** app/(shell)/dashboard/settings/security/page.tsx — password, sessions, recent activity. */
  accountSecurity:      "/dashboard/settings/security",
  /** app/(shell)/dashboard/settings/notifications/page.tsx — the category × channel matrix. */
  notificationSettings: "/dashboard/settings/notifications",
  /** app/(shell)/dashboard/connections/page.tsx — where reconnect (Plaid Link update mode) lives. */
  connections:          "/dashboard/connections",
} as const;

/** `<base><path>`, trailing slashes on base normalised, validated http(s). */
export function buildAppLink(base: string, path: string): string {
  if (!path.startsWith("/")) throw new Error("email: app path must start with /");
  return safeHttpUrl(`${base.replace(/\/+$/, "")}${path}`);
}
