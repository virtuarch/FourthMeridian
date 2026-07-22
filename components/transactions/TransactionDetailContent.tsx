"use client";

/**
 * components/transactions/TransactionDetailContent.tsx
 *
 * TI5-3B — display-only rendering of a TransactionDetail. All projection logic
 * (which sections/rows exist, wording, null-suppression) lives in the pure,
 * tested lib/transactions/detail-sections.ts; this component only lays out the
 * result. Dashboard-agnostic.
 */

import type { TransactionDetail } from "@/types";
import { buildTransactionDetailSections } from "@/lib/transactions/detail-sections";

export function TransactionDetailContent({ detail }: { detail: TransactionDetail }) {
  const sections = buildTransactionDetailSections(detail);
  return (
    <div className="space-y-5">
      {sections.map((section) => (
        <section key={section.title}>
          <h3
            className="text-xs font-semibold uppercase tracking-wide mb-2"
            style={{ color: "var(--text-faint)" }}
          >
            {section.title}
          </h3>

          {section.rows && section.rows.length > 0 && (
            <dl className="space-y-1.5">
              {section.rows.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4">
                  <dt className="text-sm shrink-0" style={{ color: "var(--text-muted)" }}>{row.label}</dt>
                  <dd
                    className="text-sm font-medium text-right tabular-nums"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {section.notes && section.notes.length > 0 && (
            <ul className="space-y-1.5">
              {section.notes.map((note) => (
                <li key={note} className="text-sm" style={{ color: "var(--text-secondary)" }}>{note}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
