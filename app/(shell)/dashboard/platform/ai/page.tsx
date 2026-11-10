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
 * It reads no Platform data at all.
 *
 * Platform AI v0 — behind PLATFORM_AI_ENABLED (lib/env.ts, default OFF). Off,
 * the page is EXACTLY the placeholder above; on, it renders the question box
 * (components/platform/PlatformAiAsk), whose API (POST /api/platform/ai/ask)
 * re-applies every gate server-side. The flag is read after the gates, so the
 * gate order is unchanged either way.
 *
 * Platform AI conversations (B11, PR C) — ONLY when env.isPlatformAiConversationsEnabled
 * (PLATFORM_AI_ENABLED + PLATFORM_AI_CONVERSATIONS_ENABLED + PLATFORM_AI_PURGE_ENABLED,
 * all default OFF), decided HERE, server-side, after every gate: the page renders
 * components/platform/PlatformAiConversations (whose routes,
 * /api/platform/ai/conversations/*, re-apply every gate). Any of the three unset
 * ⇒ exactly v0 (PlatformAiAsk) as before. Design:
 * docs/plans/PLATFORM-AI-CONVERSATIONS-DESIGN.md §11.
 */

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { redirectToLogin } from "@/lib/auth/login-redirect";
import { loadPlatformDirectory, operatorHasTotp } from "@/lib/platform/directory.server";
import { OPERATOR_TOTP_ENROLMENT_PATH } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { PlatformAiPlaceholder } from "@/components/platform/PlatformAiPlaceholder";
import { PlatformAiAsk } from "@/components/platform/PlatformAiAsk";
import { PlatformAiConversations } from "@/components/platform/PlatformAiConversations";
import { platformAiAreaFor, platformAiAreaLabel, platformAiAreasFor } from "@/lib/platform/intelligence/ai/core";
import { showsSubjectNotice } from "@/lib/platform/intelligence/ai/authz/subject-notice";
import { isMemoryEffective } from "@/lib/platform/intelligence/ai/memory/gate";

export const runtime = "nodejs";

export default async function PlatformAiPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();

  const spaces = await loadPlatformDirectory(session.user.id);
  if (spaces.length === 0) redirect("/dashboard/spaces");
  if (env.isOperatorTotpEnforced && !(await operatorHasTotp(session.user.id))) redirect(OPERATOR_TOTP_ENROLMENT_PATH);

  if (!env.isPlatformAiEnabled) return <PlatformAiPlaceholder />;
  // The ONE area the API answers from (the same function the route uses), stated on the page.
  const area = platformAiAreaFor(spaces);
  if (!area) redirect("/dashboard/spaces");
  // Platform AI operational memory (design v2 §6): ONLY when isMemoryEffective — decided HERE, server-side,
  // after every gate. Off ⇒ the conversations page exactly as before (the original short line, no panel, no card).
  // P5 (S2 09dp): the customer-lookup notice wherever the customers pack is offered (strict flag + a CS grant).
  const subjectNotice = showsSubjectNotice({ customersPackOn: env.isPlatformAiPackCustomersEnabled, areas: platformAiAreasFor(spaces) });
  if (env.isPlatformAiConversationsEnabled) return <PlatformAiConversations areaLabel={platformAiAreaLabel(area)} memory={isMemoryEffective(env)} subjectNotice={subjectNotice} />;
  return <PlatformAiAsk areaLabel={platformAiAreaLabel(area)} subjectNotice={subjectNotice} />;
}
