/**
 * scripts/marketing-showcase/scenes.tsx — the capture harness's browser entry.
 *
 * Each scene mounts REAL Fourth Meridian components — the Space header markup,
 * the PerspectiveShell period picker, and the workspace components in the order
 * and grid the Space pages use — over the synthetic fixture. No fetch, no
 * session, no provider: the components receive what the product's own engines
 * (computeWealthTimeMachine, buildCashFlowSpaceData …) compute from fixture rows.
 * `#scene` in the URL picks the scene.
 */
import { createRoot } from "react-dom/client";
import { useState, type ReactNode } from "react";
import { computeWealthTimeMachine } from "@/lib/wealth/wealth-time-machine";
import { resolvePerspectiveEnvelope, type PerspectiveEnvelope } from "@/lib/perspectives/envelope";
import type { PerspectiveTimeState } from "@/lib/perspectives/time-range";
import type { CashFlowPeriod } from "@/lib/transactions/cash-flow";
import type { Transaction } from "@/types";
import { PerspectiveShell } from "@/components/space/shell/PerspectiveShell";
import { WealthHero } from "@/components/space/widgets/wealth/WealthHero";
import { WealthTrendChart } from "@/components/space/widgets/wealth/WealthTrendChart";
import { WealthCompositionCard } from "@/components/space/widgets/wealth/WealthCompositionCard";
import { WealthChangeLedger } from "@/components/space/widgets/wealth/WealthChangeLedger";
import { CashFlowWorkspace, type FlowView } from "@/components/space/widgets/cashflow/CashFlowWorkspace";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { AiShell } from "@/components/ai/AiShell";
import { Composer } from "@/components/ai/Composer";
import { ConversationView } from "@/components/ai/ConversationView";
import type { AiMessage } from "@/components/ai/types";
import { ConnectionsList } from "@/components/connections/ConnectionsList";
import { formatCurrencyWhole } from "@/lib/currency";
import { DEMO_ACCOUNTS, DEMO_CURRENCY, DEMO_TODAY, addDays, demoConnections, demoSnapshots, demoTransactions } from "./fixture";

const noop = () => {};
const params = new URLSearchParams(location.hash.slice(1));
const SCENE = params.get("scene") ?? location.hash.slice(1).split("&")[0];
/** "full" = header + period picker + content; "content" = workspace only. */
const CHROME = params.get("chrome") ?? "full";

/** The Space page frame: SpaceShell's compact title row (<lg) + PerspectiveShell. */
function SpaceFrame({ envelope, timeState, children }: { envelope: PerspectiveEnvelope; timeState: PerspectiveTimeState; children: ReactNode }) {
  return (
    <div data-capture className="bg-[var(--bg-base)] px-4 py-6 sm:px-8 sm:py-8">
      <div className="max-w-5xl mx-auto">
        {CHROME === "full" && (
          <>
            <div className="lg:hidden mb-5 flex items-center justify-between gap-3">
              <h1 className="truncate text-lg font-semibold text-[var(--text-primary)]">Personal</h1>
            </div>
            <div className="hidden lg:flex mb-6 items-baseline justify-between">
              <h1 className="text-xl font-semibold text-[var(--text-primary)]">Personal</h1>
            </div>
            <div className="mb-8 max-lg:mb-6">
              <PerspectiveShell
                today={DEMO_TODAY}
                onAsOfChange={noop} onCompareToChange={noop} onSwap={noop} onSelectPreset={noop}
                envelope={envelope}
                timeState={timeState}
                tabs={[]} activeTabId={null} onSelectTab={noop} tabsVisibility="none"
              />
            </div>
          </>
        )}
        {children}
      </div>
    </div>
  );
}

const RANGE_DAYS: Record<string, number> = { PAST_YEAR: 365, PAST_QUARTER: 92, PAST_6_MONTHS: 183 };

function NetWorthScene() {
  const preset = params.get("range") ?? "PAST_YEAR";
  const compareTo = addDays(DEMO_TODAY, -RANGE_DAYS[preset]);
  const result = computeWealthTimeMachine({ snapshots: demoSnapshots(), asOf: DEMO_TODAY, compareTo, currency: DEMO_CURRENCY });
  const envelope = resolvePerspectiveEnvelope({ perspectiveId: "wealth", wealthResult: result, currency: DEMO_CURRENCY });
  return (
    <SpaceFrame envelope={envelope} timeState={{ preset: preset as never, asOf: DEMO_TODAY, compareTo }}>
      <div className="space-y-8 sm:space-y-10 min-w-0 max-lg:space-y-6!">
        <WealthHero result={result} currency={DEMO_CURRENCY} envelope={envelope} metric="netWorth" />
        <div id="showcase-chart"><WealthTrendChart result={result} currency={DEMO_CURRENCY} metric="netWorth" /></div>
        {params.get("detail") !== "0" && (
          <div className="grid gap-6 lg:grid-cols-12 lg:gap-8 items-start">
            <div className="min-w-0 lg:col-span-7"><WealthCompositionCard result={result} currency={DEMO_CURRENCY} metric="netWorth" /></div>
            <div className="min-w-0 lg:col-span-5"><WealthChangeLedger result={result} currency={DEMO_CURRENCY} metric="netWorth" /></div>
          </div>
        )}
      </div>
    </SpaceFrame>
  );
}

function CashFlowScene({ view }: { view: FlowView }) {
  const [env, setEnv] = useState<PerspectiveEnvelope>(() => resolvePerspectiveEnvelope({ perspectiveId: "cashFlow", currency: DEMO_CURRENCY }));
  const [period, setPeriod] = useState<CashFlowPeriod>((params.get("period") as CashFlowPeriod) ?? "PAST_MONTH");
  const tx = demoTransactions().map((r) => ({
    ...r, description: r.merchant, merchantDisplayName: r.merchant, currency: DEMO_CURRENCY,
    pending: false, financialAccountId: r.accountId,
  })) as unknown as Transaction[];
  return (
    <SpaceFrame envelope={env} timeState={{ preset: period as never, asOf: DEMO_TODAY, compareTo: addDays(DEMO_TODAY, period === "PAST_QUARTER" ? -92 : -30) }}>
      <CashFlowWorkspace
        view={view}
        transactions={tx}
        accounts={DEMO_ACCOUNTS as never}
        period={period}
        asOf={DEMO_TODAY}
        today={DEMO_TODAY}
        compareTo={addDays(DEMO_TODAY, -30)}
        onSelectPeriod={setPeriod}
        onEnvelopeChange={setEnv}
      />
    </SpaceFrame>
  );
}

/* ── Conversations ─────────────────────────────────────────────────────────
 * The page is the real AiShell + ConversationView + Composer. The words of the
 * answer are an EXAMPLE (a live answer is model-written), but every figure in
 * it is taken from the same engine result the Net Worth scene shows, so the
 * example never states a number the demo household does not have. */
function ConversationScene() {
  const result = computeWealthTimeMachine({ snapshots: demoSnapshots(), asOf: DEMO_TODAY, compareTo: addDays(DEMO_TODAY, -365), currency: DEMO_CURRENCY });
  const d = result.deltas!;
  const $ = (n: number) => formatCurrencyWhole(Math.abs(n), DEMO_CURRENCY);
  const stage = params.get("stage") ?? "answer";
  const question = "What moved my net worth over the last year?";
  const answer = [
    `Your net worth rose **${$(d.netWorth.abs)}** (${d.netWorth.pct!.toFixed(1)}%) between Oct 15, 2025 and Oct 15, 2026, to **${$(result.asOfState.netWorth)}**.`,
    "",
    "Where it came from:",
    "",
    `- **Investments: +${$(d.composition.investments)}.** Most of the gain — market movement plus your regular contributions.`,
    `- **Home value: +${$(d.composition.real)}.** From the two valuations you entered for your home.`,
    `- **Cash: +${$(d.composition.cash)}.** Your bank balances finished the year higher than they started.`,
    `- **Debt: −${$(d.composition.liabilities)}.** Mortgage principal and your card balance came down, which adds to net worth.`,
    `- **Crypto: ${d.composition.crypto >= 0 ? "+" : "−"}${$(d.composition.crypto)}.** ${d.composition.crypto >= 0 ? "A small gain" : "A small decline"} over the year.`,
    "",
    "The home figure is your own estimate, so that part of the change is only as current as your last valuation.",
  ].join("\n");
  const messages: AiMessage[] = stage === "question"
    ? [{ role: "user", content: question }]
    : [{ role: "user", content: question }, { role: "assistant", content: answer }];
  return (
    // `&h=` fixes the shell height (the app sizes it to the viewport), so the
    // composer docks at the bottom of every frame exactly as on the page.
    <div data-capture className="bg-[var(--bg-base)] px-4 py-5 sm:px-8 sm:py-6 [&_[data-ai-layout]]:h-(--showcase-shell-h)!"
      style={{ ["--showcase-shell-h" as string]: `${Number(params.get("h") ?? 600)}px` }}>
      <div className="max-w-5xl mx-auto">
        <AiShell
          mode="conversation"
          contextLabel="Personal"
          composer={<Composer value={stage === "typing" ? question : ""} onChange={noop} onSubmit={noop} onStop={noop} busy={stage === "question"} />}
        >
          <ConversationView messages={stage === "typing" ? [] : messages} busy={stage === "question"} />
        </AiShell>
      </div>
    </div>
  );
}

/* ── Connections ─────────────────────────────────────────────────────────── */
const inertRouter = { push: noop, replace: noop, refresh: noop, prefetch: noop, back: noop, forward: noop } as never;
function ConnectionsScene() {
  const { status, accountsByConnectionId, manualAssets } = demoConnections();
  return (
    <AppRouterContext.Provider value={inertRouter}>
      <PathnameContext.Provider value="/connections">
        <SearchParamsContext.Provider value={new URLSearchParams() as never}>
          <div data-capture className="bg-[var(--bg-base)] px-4 py-6 sm:px-8 sm:py-8">
            <div className="max-w-5xl mx-auto">
              <div className="mb-5">
                <h1 className="text-xl font-bold text-[var(--text-primary)]">Connections</h1>
                <p className="text-sm text-[var(--text-muted)]">Manage the institutions, wallets and assets you&apos;ve brought into Fourth Meridian.</p>
              </div>
              <ConnectionsList initialStatus={status} accountsByConnectionId={accountsByConnectionId} manualAssets={manualAssets as never} />
            </div>
          </div>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  "conversation": ConversationScene,
  "connections": ConnectionsScene,
  "net-worth": NetWorthScene,
  "cash-flow": () => <CashFlowScene view="cashFlow" />,
  "spending": () => <CashFlowScene view="spending" />,
};

// `&hide=a,b` crops whole sections out of a frame (display:none by anchor id) —
// a framing choice for the website, never a change to what a section shows.
const hide = (params.get("hide") ?? "").split(",").filter(Boolean);
if (hide.length) {
  const style = document.createElement("style");
  style.textContent = hide.map((id) => `#${CSS.escape(id)}`).join(",") + "{display:none!important}";
  document.head.appendChild(style);
}

const Scene = SCENES[SCENE];
createRoot(document.getElementById("root")!).render(Scene ? <Scene /> : <p style={{ color: "red" }}>unknown scene {SCENE}</p>);
// The capture script waits for this flag (a few frames after mount, so layout
// effects — the chart measures its width — and envelope updates have settled).
setTimeout(() => requestAnimationFrame(() => { document.body.dataset.ready = "1"; }), 300);
