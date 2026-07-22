import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getLatestAdvice } from "@/lib/data/advice";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function AnalyzePage() {
  // AI Experience Convergence (AI-2): the destination is conversation-first. Only the
  // scheduled-advice capability (AdviceBanner, in the empty state) needs server data;
  // the former ML-Review stat reads (FICO / snapshots) fed only the retired cards.
  const [advice, session] = await Promise.all([
    getLatestAdvice(),
    getServerSession(authOptions),
  ]);

  // First name only — falls back to "there" if no name on record
  const fullName = session?.user?.name ?? "";
  const userName = fullName.split(" ")[0] || "there";

  return <AnalyzeClient advice={advice} userName={userName} />;
}
