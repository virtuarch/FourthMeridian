import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { redirectToLogin } from "@/lib/auth/login-redirect";

// Settings index (UI Convergence Wave 1 — W1-B). The old hub link-list is retired:
// the SpaceShell rail (settings/layout.tsx) is now the section navigation. The bare
// /dashboard/settings destination lands on the first section; every section keeps
// its own canonical URL (D3). Archived-assets stays reachable from Data & Privacy.
export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return redirectToLogin();
  redirect("/dashboard/settings/account");
}
