/**
 * scripts/backfill-wallet-connections.ts
 *
 * Wallet Provider v1.5 backfill — give every pre-v1.5 wallet account a real
 * Connection(WALLET) and link its AccountConnection + ProviderAccountIdentity
 * to it. Reuses the exact same idempotent helper the live add/sync paths use
 * (alignWalletProviderSpine), so running this is equivalent to re-adding each
 * wallet — no duplicate accounts, no schema change, no balance change.
 *
 * Idempotent and safe to re-run: wallets that already have a linked Connection
 * are no-ops.
 *
 * Usage:
 *   npx tsx scripts/backfill-wallet-connections.ts          # apply
 *   npx tsx scripts/backfill-wallet-connections.ts --dry-run # report only
 *
 * NOTE: the live paths already self-heal — adding, re-adding, reactivating, or
 * syncing a wallet aligns its spine — so this script is only needed to backfill
 * wallets that won't be touched again soon.
 */

import { db } from "@/lib/db";
import { alignWalletProviderSpine } from "@/lib/accounts/wallet-connection";

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  // Every active self-custodied wallet: a walletChain + walletAddress + owner.
  const wallets = await db.financialAccount.findMany({
    where: {
      deletedAt:     null,
      walletChain:   { not: null },
      walletAddress: { not: null },
      ownerUserId:   { not: null },
    },
    select: { id: true, ownerUserId: true, walletAddress: true, walletChain: true },
  });

  console.log(`[backfill-wallet-connections] found ${wallets.length} active wallet account(s)${dryRun ? " (dry run)" : ""}`);

  let aligned = 0;
  let failed = 0;

  for (const w of wallets) {
    // Type guard — the where-clause guarantees these are non-null at runtime.
    if (!w.ownerUserId || !w.walletAddress || !w.walletChain) continue;

    if (dryRun) {
      console.log(`  would align account ${w.id} (${w.walletChain}:${w.walletAddress})`);
      continue;
    }

    const connectionId = await alignWalletProviderSpine({
      userId:             w.ownerUserId,
      financialAccountId: w.id,
      address:            w.walletAddress,
      chain:              w.walletChain,
    });

    if (connectionId) {
      aligned++;
    } else {
      failed++;
      console.warn(`  alignment returned null for account ${w.id}`);
    }
  }

  console.log(`[backfill-wallet-connections] done — aligned=${aligned} failed=${failed} total=${wallets.length}`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error("[backfill-wallet-connections] crashed:", e);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
