/**
 * components/atlas/EmptyState.tsx  (UI Convergence Wave 1 — W1-D)
 *
 * The one shared empty-state block — an icon, a title, an optional description, and
 * an optional action. Promoted to Atlas to replace the private, duplicated
 * `EmptyState()` helpers (ArchivedAssetsClient, TimelineWidget). Domain-neutral.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      {Icon && (
        <div
          className="w-10 h-10 rounded-[var(--radius-lg)] flex items-center justify-center mb-1"
          style={{ background: "var(--surface-inset)", color: "var(--text-muted)" }}
        >
          <Icon size={18} aria-hidden />
        </div>
      )}
      <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{title}</p>
      {description && <p className="text-xs max-w-xs" style={{ color: "var(--text-muted)" }}>{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
