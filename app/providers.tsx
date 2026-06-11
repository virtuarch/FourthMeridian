"use client";

/**
 * app/providers.tsx
 *
 * Client-side providers wrapper. Keeps app/layout.tsx a Server Component
 * while still making the NextAuth session available to all client components
 * via useSession().
 */

import { SessionProvider } from "next-auth/react";
import { PlaidProvider } from "@/context/PlaidContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <PlaidProvider>{children}</PlaidProvider>
    </SessionProvider>
  );
}
