/**
 * components/auth/AuthShell.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The Fourth Meridian "front door" — the shared frame every (auth) route renders
 * inside, wired once from app/(auth)/layout.tsx. A split identity experience:
 * a brand panel on the left (desktop) and the form column on the right. On a
 * phone the brand panel collapses and the form's own AuthHeader carries the mark.
 *
 * This is NOT SpaceShell. It has no rail, no workspace, no runtime — auth lives
 * before the app. It only provides the ambient background, the brand panel, and a
 * scrollable, centered slot for the page's AuthCard. Token-driven, so it renders
 * correctly under whichever html[data-theme] block is active (dark today).
 */

import { AppLogo } from "@/components/ui/AppLogo";
import type { ReactNode } from "react";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-[100svh] w-full bg-[var(--bg-deep)] text-[var(--text-primary)]">
      {/* Ambient light — a meridian dawn top-left, a brass ember bottom-right.
          Pure CSS gradients (no asset dependency), sitting under everything. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 10% -10%, rgba(59,130,246,0.18), transparent 55%), " +
            "radial-gradient(100% 80% at 100% 112%, rgba(201,162,39,0.10), transparent 55%)",
        }}
      />

      {/* ── Brand panel — desktop only ─────────────────────────────────────── */}
      <aside className="relative hidden w-[44%] max-w-[560px] flex-col justify-between overflow-hidden border-r border-[var(--border-hairline)] p-12 lg:flex xl:p-16">
        <div className="relative z-10">
          <AppLogo
            size={40}
            withWordmark
            wordmarkClassName="text-xl text-[var(--text-primary)]"
            priority
          />
        </div>

        <div className="relative z-10 max-w-sm">
          <h2 className="text-[32px] font-semibold leading-[1.15] tracking-tight text-[var(--text-primary)]">
            Your financial
            <br />
            operating system.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-[var(--text-secondary)]">
            Net worth, investments, crypto, and debt — tracked, reconciled, and
            understood in one place.
          </p>
        </div>

        <p className="relative z-10 text-xs text-[var(--text-faint)]">
          Bank-grade encryption · Your data stays yours
        </p>
      </aside>

      {/* ── Form column ────────────────────────────────────────────────────── */}
      <main className="relative flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-4 py-10 sm:px-6">
          {children}
        </div>
      </main>
    </div>
  );
}
