/**
 * app/(auth)/layout.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The one shared frame for every authentication route (login, register,
 * forgot/reset password, verify / confirm-email-change). Previously absent — each
 * page hand-rolled its own full-screen `bg-gray-950` wrapper. Now the pages render
 * only their AuthCard, and this layout supplies the AuthShell "front door" around
 * them.
 *
 * No auth behavior lives here: no session read, no redirect (route protection is
 * still proxy.ts's job). It is presentation only.
 */

import { AuthShell } from "@/components/auth/AuthShell";
import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
