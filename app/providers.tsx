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
import { ThemeProvider } from "@/components/theme/ThemeProvider";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SessionProvider>
        <PlaidProvider>{children}</PlaidProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
