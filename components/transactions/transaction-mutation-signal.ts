"use client";

/**
 * components/transactions/transaction-mutation-signal.ts  (TX-3.4)
 *
 * A one-event notification seam: "a transaction was mutated".
 *
 * WHY IT EXISTS
 *   The detail drawer is mounted in DashboardChrome; the explorer list is mounted
 *   inside the Transactions workspace. They are SIBLINGS, not ancestor/descendant,
 *   so a correction made in the drawer has no prop path back to the list. Without a
 *   seam the list would keep showing a stale row — still labelled "Dining" after the
 *   user recategorized it to "Travel" — which is the dishonesty TX-3 exists to remove.
 *
 * WHAT IT IS NOT
 *   Not a store, not a cache, not an authority. It carries NO transaction data — only
 *   a monotonic version. Consumers re-ask their own question through their own
 *   authority; nothing here decides what the answer is. Deliberately minimal so it
 *   cannot grow into a client-side truth model.
 *
 * Shaped for useSyncExternalStore (the idiom this repo already uses for
 * hydration-safe external reads), so a consumer subscribes without setState-in-effect.
 */

let version = 0;
const listeners = new Set<() => void>();

/** Announce that a transaction changed. Called by whatever performed the mutation. */
export function notifyTransactionMutated(): void {
  version += 1;
  listeners.forEach((l) => l());
}

/** useSyncExternalStore subscribe. */
export function subscribeTransactionMutations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** useSyncExternalStore getSnapshot — a monotonic version, stable between mutations. */
export function getTransactionMutationVersion(): number {
  return version;
}

/** Server snapshot — always 0, so SSR and first hydration agree. */
export function getServerTransactionMutationVersion(): number {
  return 0;
}
