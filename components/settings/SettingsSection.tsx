/**
 * components/settings/SettingsSection.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one titled configuration card: a DataCard with an icon + title header and an
 * optional description, replacing the hand-repeated
 * `<DataCard><icon + DataCardTitle>…</DataCard>` block at the top of every settings
 * section. A thin composition over the existing Atlas DataCard (the generic card
 * primitive) — kept in components/settings until a second consumer (Admin) promotes
 * it, per "no generic abstraction before a second consumer".
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DataCard, DataCardTitle } from "@/components/atlas/DataCard";

export function SettingsSection({
  icon: Icon,
  title,
  description,
  danger,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Danger-zone header tint (Deactivate / Delete). */
  danger?: boolean;
  children: ReactNode;
}) {
  const iconColor = danger ? "var(--accent-negative)" : "var(--text-secondary)";
  return (
    <DataCard>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={15} style={{ color: iconColor }} />
        <DataCardTitle>{title}</DataCardTitle>
      </div>
      {description && <p className="text-xs mb-4" style={{ color: "var(--text-faint)" }}>{description}</p>}
      {children}
    </DataCard>
  );
}
