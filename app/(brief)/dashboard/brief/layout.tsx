/**
 * app/(brief)/dashboard/brief/layout.tsx
 *
 * Standalone layout for the Daily Brief — no sidebar, no nav, no chrome.
 * Lives in the (brief) route group so it does not inherit the shell layout
 * from (shell)/dashboard/layout.tsx.
 *
 * Metadata is exported only from page.tsx to avoid registering two
 * metadata-collector entries for the same route in Turbopack, which caused
 * next-font-manifest.json ENOENT errors under HMR.
 */

import Image from "next/image";
import { UserMenu } from "@/components/brief/UserMenu";
import { ReactNode } from "react";

export default function BriefLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#030712] text-white overflow-x-hidden">

      {/* ── Top bar ───────────────────────────────────────────────────────────── */}
      <header className="absolute top-0 left-0 right-0 z-30 flex items-center justify-between px-6 md:px-10 py-5">
        <Image
          src="/logo-icon.png"
          alt="FinTracker"
          width={36}
          height={36}
          className="rounded-xl"
          priority
        />
        <UserMenu />
      </header>

      {/* ── Page content ──────────────────────────────────────────────────────── */}
      {children}
    </div>
  );
}
