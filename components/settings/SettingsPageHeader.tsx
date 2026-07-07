/**
 * components/settings/SettingsPageHeader.tsx
 *
 * Shared drill-down header for Settings sub-pages (UX-1). Renders a
 * "← Settings" back affordance plus the page title/subtitle. Server-safe
 * (plain Link, no client state) so sub-pages can stay Server Components.
 */

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export function SettingsPageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="space-y-1">
      <Link
        href="/dashboard/settings"
        className="inline-flex items-center gap-1 text-xs transition-colors hover:text-[var(--text-secondary)]"
        style={{ color: "var(--text-muted)" }}
      >
        <ChevronLeft size={13} /> Settings
      </Link>
      <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>{title}</h1>
      {subtitle && <p className="text-sm" style={{ color: "var(--text-muted)" }}>{subtitle}</p>}
    </div>
  );
}
