"use client";

/**
 * components/transactions/useTransactionDrawer.ts
 *
 * Shared open/close/read helpers for the Transaction Detail drawer (TI5-3A).
 * The drawer is driven by the `?transaction=<id>` search param so it is
 * shareable, refresh-survivable, and closed naturally by the browser Back
 * button (opening pushes a history entry; Back pops it).
 *
 * Two hooks by design:
 *  - useOpenTransaction — opener only (useRouter + usePathname). It does NOT
 *    call useSearchParams, so row surfaces can use it WITHOUT a Suspense
 *    boundary. This is the single shared opener every list wires to.
 *  - useTransactionDrawer — the reader (uses useSearchParams to read the param
 *    and to remove it on close). Its consumer (the drawer) must sit under a
 *    <Suspense> boundary, per Next's useSearchParams requirement.
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildSpaceUrl } from "@/lib/space/space-url";

const PARAM = "transaction";

/** Returns `openTransaction(id)` — Suspense-free (no useSearchParams). */
export function useOpenTransaction() {
  const router = useRouter();
  const pathname = usePathname();
  return useCallback(
    (id: string) => {
      // SD-0A: serialize through the shared Space URL core so opening the drawer
      // PRESERVES the active tab/perspective/time params (it can no longer clobber
      // them). push (not replace) so the browser Back button naturally closes it.
      const search = typeof window === "undefined" ? "" : window.location.search;
      router.push(buildSpaceUrl(pathname, search, { [PARAM]: id }));
    },
    [router, pathname],
  );
}

/** Reader + close for the drawer. Consumers must be under a <Suspense> boundary. */
export function useTransactionDrawer() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openTransaction = useOpenTransaction();
  const transactionId = searchParams.get(PARAM);

  const close = useCallback(() => {
    // Symmetric with browser Back: pop the entry opening pushed. Fall back to a
    // param-stripping replace if there is no in-app history to pop (deep link) —
    // serialized through the shared core so it preserves every unrelated param.
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    const search = typeof window === "undefined" ? searchParams.toString() : window.location.search;
    router.replace(buildSpaceUrl(pathname, search, { [PARAM]: null }));
  }, [router, pathname, searchParams]);

  return { transactionId, openTransaction, close };
}
