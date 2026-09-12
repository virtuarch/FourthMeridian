import { getLatestAdvice } from "@/lib/data/advice";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";
import { starterIndexFrom } from "@/components/ai/conversation-surface";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function AnalyzePage() {
  // AI Experience Convergence (AI-2): the destination is conversation-first. Only the
  // scheduled-advice capability (AdviceBanner, in the empty state) needs server data;
  // the former ML-Review stat reads (FICO / snapshots) fed only the retired cards.
  const advice = await getLatestAdvice();

  // AI-3: the empty-state starter line is chosen here, per request, so the server
  // render and hydration agree on it — no client-side re-pick, no flicker. (The
  // dashboard layout reads the session, so this route is always dynamic.)
  // An async server component renders once per request, so the purity rule's concern
  // (unstable output across re-renders) does not apply; varying per visit is the point.
  // eslint-disable-next-line react-hooks/purity
  const starterIndex = starterIndexFrom(Math.random());

  return <AnalyzeClient advice={advice} starterIndex={starterIndex} />;
}
