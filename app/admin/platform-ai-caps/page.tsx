/**
 * app/admin/platform-ai-caps/page.tsx — Platform AI caps (PLATFORM AI CAPS D5 PR5)
 *
 * The SYSTEM_ADMIN editor for the Platform AI daily estimated-spend caps: the
 * platform-wide defaults and per-operator overrides. Access is gated by
 * app/admin/layout.tsx (any non-SYSTEM_ADMIN is redirected before reaching here);
 * the API it calls (/api/admin/platform-ai-caps) re-checks SYSTEM_ADMIN on GET and
 * fresh SYSTEM_ADMIN on every POST.
 *
 * This server shell only reads the signed-in admin's id so the client can mark the
 * "You" row; the id is compared, never rendered.
 */

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { PlatformAiCapsAdmin } from "@/components/admin/PlatformAiCapsAdmin";

export default async function PlatformAiCapsPage() {
  const session = await getServerSession(authOptions);
  return <PlatformAiCapsAdmin selfUserId={session?.user?.id ?? null} />;
}
