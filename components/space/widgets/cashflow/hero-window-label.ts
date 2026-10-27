/**
 * components/space/widgets/cashflow/hero-window-label.ts
 *
 * The compact hero card's R4 line for Cash Flow / Spending: the workspace's window
 * label ("as of Oct 27, 2026" or an explicit period's range) as a standalone line,
 * sentence-cased like the other perspectives' R4 ("As of Oct 27, 2026").
 */
export function compactWindowLabel(windowLabel: string): string {
  return windowLabel ? windowLabel.charAt(0).toUpperCase() + windowLabel.slice(1) : windowLabel;
}
