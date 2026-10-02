import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth/return-to";
import { AuthCard, AuthHeader } from "@/components/auth";
import { LoginForm } from "./LoginForm";

/**
 * /login — server entry.
 *
 * Two decisions live here, on the server, rather than in the client form:
 *
 * 1. THE RETURN TARGET. `?callbackUrl` is validated once, by
 *    lib/auth/return-to.ts, and handed to the form as a same-origin path. An
 *    unsafe or absent value becomes /dashboard/brief.
 *
 * 2. A SIGNED-IN VISITOR DOES NOT SEE THE FORM. They go straight to the
 *    validated return target. This uses getServerSession — which runs the
 *    session callback's REVOCATION check — and deliberately not the proxy's
 *    signature-only getToken: a revoked-but-signed JWT must render the form
 *    here, or /login and the protected page would bounce the user between
 *    them forever. If the session read itself fails (authority unavailable),
 *    the form renders: the login page must never depend on a working session
 *    store to be reachable.
 */
async function hasLiveSession(): Promise<boolean> {
  try {
    const session = await getServerSession(authOptions);
    return Boolean(session?.user?.id);
  } catch {
    return false;
  }
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { callbackUrl } = await searchParams;
  // A repeated ?callbackUrl is ambiguous — treat it as absent.
  const returnTo = safeReturnTo(typeof callbackUrl === "string" ? callbackUrl : undefined);

  if (await hasLiveSession()) redirect(returnTo);

  return (
    <AuthCard>
      <AuthHeader title="Welcome back" subtitle="Sign in to your dashboard" />

      <Suspense fallback={<p className="text-center text-sm text-[var(--text-muted)]">Loading…</p>}>
        <LoginForm returnTo={returnTo} />
      </Suspense>
    </AuthCard>
  );
}
