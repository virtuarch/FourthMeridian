/**
 * app/(shell)/dashboard/platform/ai/page.tsx  (Platform Operations 2.0 — R1)
 *
 * The Platform context's AI destination — an honest "not available yet" shell
 * (components/platform/PlatformAiPlaceholder). Server Component.
 *
 * ROUTING — `ai` is a STATIC segment, so the App Router matches it before the
 * dynamic [area] sibling; PlatformArea values are UPPER_CASE enums, so "ai" is
 * never an area either way (lib/platform/nav `isPlatformAreaValue`).
 *
 * Gate order — EXACTLY the Platform directory's (app/(shell)/dashboard/platform/
 * page.tsx), so the AI page is reachable by precisely the viewers the directory
 * is (no new authority, no route-guard change):
 *   1. a session must exist                    → else /login
 *   2. at least one ACTIVE PlatformGrant        → else /dashboard/spaces
 *   3. operator 2FA, when enforced              → else the enrolment screen
 * It reads no Platform data at all; there is nothing behind it yet.
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { loadPlatformDirectory, operatorHasTotp } from "@/lib/platform/directory.server";
import { OPERATOR_TOTP_ENROLMENT_PATH } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { PlatformAiPlaceholder } from "@/components/platform/PlatformAiPlaceholder";

export const runtime = "nodejs";

export default async function PlatformAiPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  const spaces = await loadPlatformDirectory(session.user.id);
  if (spaces.length === 0) redirect("/dashboard/spaces");
  if (env.isOperatorTotpEnforced && !(await operatorHasTotp(session.user.id))) redirect(OPERATOR_TOTP_ENROLMENT_PATH);

  return <PlatformAiPlaceholder />;
}
