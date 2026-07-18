/**
 * components/auth/AuthCard.tsx  (UI Convergence Wave 2 — W2-A)
 *
 * The glass panel that holds an auth form. One Atlas GlassPanel (the app's
 * canonical frosted surface) at the `floating` depth — the most separated tier,
 * right for a hero card sitting over the AuthShell's ambient background. Replaces
 * the six duplicated `max-w-sm space-y-6` wrappers the (auth) pages hand-rolled.
 *
 * `width` matches the old per-page widths: "sm" (login/reset/forgot/verify/…) or
 * "md" (the longer register form).
 */

import { GlassPanel } from "@/components/atlas/GlassPanel";
import type { ReactNode } from "react";

const WIDTH: Record<"sm" | "md", string> = {
  sm: "max-w-[400px]",
  md: "max-w-[460px]",
};

export function AuthCard({
  width = "sm",
  children,
}: {
  width?: "sm" | "md";
  children: ReactNode;
}) {
  return (
    <GlassPanel
      depth="floating"
      elevation="e4"
      radius="xl"
      className={`w-full ${WIDTH[width]} p-7 sm:p-8`}
    >
      <div className="space-y-6">{children}</div>
    </GlassPanel>
  );
}
