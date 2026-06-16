import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getLatestAdvice } from "@/lib/data/advice";
import { getFicoScore } from "@/lib/data/accounts";
import { getRecentSnapshots } from "@/lib/data/snapshots";
import { AnalyzeClient } from "@/components/dashboard/AnalyzeClient";

export default async function AnalyzePage() {
  const t0 = Date.now();
  const time = <T,>(label: string, p: Promise<T>): Promise<T> => {
    const s = Date.now();
    return p.then((r) => { console.log(`[page:analyze]   ${label}: ${Date.now() - s}ms`); return r; });
  };
  const [advice, ficoScore, snapshots, session] = await Promise.all([
    time("getLatestAdvice", getLatestAdvice()),
    time("getFicoScore", getFicoScore()),
    time("getRecentSnapshots(30)", getRecentSnapshots(30)),
    time("getServerSession", getServerSession(authOptions)),
  ]);
  console.log(`[page:analyze] Promise.all (wall clock): ${Date.now() - t0}ms`);

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

  console.log(`[page:analyze] total: ${Date.now() - t0}ms`);
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
