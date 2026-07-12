/**
 * components/space/widgets/wealth/WealthNetWorthChart.tsx
 *
 * S7 re-export shim. The chart was upgraded and renamed to WealthTrendChart (its
 * own file). WealthPerspective still imports the old name until S8 recomposes the
 * page and imports WealthTrendChart directly — at which point this shim is
 * deleted. The upgraded component's added props (metric / onMetricChange) are
 * optional, so the old call sites keep working unchanged.
 */

export { WealthTrendChart as WealthNetWorthChart } from "./WealthTrendChart";
