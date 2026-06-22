import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getLatestAdvice } from "@/lib/data/advice";
import { getFicoScore } from "@/lib/data/accounts";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";

export const preferredRegion = "sin1";
export const runtime = "nodejs";

export default async function AnalyzePage() {
  const [advice, ficoScore, snapshots, session] = await Promise.all([
    getLatestAdvice(),
    getFicoScore(),
    getRecentSnapshots(30),
    getServerSession(authOptions),
  ]);

  const latestSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  // Derived stats for the "What the Engine Reviews" grid
  const snapshotCount = snapshots.length;

  const assetClassCount = latestSnapshot
    ? [
        (latestSnapshot.totalCash + latestSnapshot.totalSavings) > 0,  // cash
        latestSnapshot.totalInvestments > 0,                            // equities
        latestSnapshot.totalCrypto > 0,                                 // crypto
      ].filter(Boolean).length
    : 0;

  const cryptoPct =
    latestSnapshot && latestSnapshot.totalAssets > 0
      ? Math.round((latestSnapshot.totalCrypto / latestSnapshot.totalAssets) * 1000) / 10
      : null;

  // First name only — falls back to "there" if no name on record
  const fullName = session?.user?.name ?? "";
  const userName = fullName.split(" ")[0] || "there";

  return (
    <AnalyzeClient
      advice={advice}
      ficoScore={ficoScore}
      latestSnapshot={latestSnapshot}
      snapshotCount={snapshotCount}
      assetClassCount={assetClassCount}
      cryptoPct={cryptoPct}
      userName={userName}
    />
  );
}
