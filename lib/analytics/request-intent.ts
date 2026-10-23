/**
 * lib/analytics/request-intent.ts  (BETA A2)
 *
 * Was this server render asked for by a PERSON, or by the router warming a
 * route? Next's App Router prefetches a `<Link>` target by requesting the same
 * URL with `Next-Router-Prefetch: 1` (and the browser's own speculative loads
 * carry `Purpose` / `Sec-Purpose: prefetch`). A page function that runs under
 * one of those renders nothing anyone looked at, so a product event written
 * from it would count a hover as a visit. Server components that record
 * SPACE_VIEWED / BRIEF_VIEWED ask this first.
 *
 * Fail-open towards "a person": if the headers cannot be read (a render outside
 * a request scope), the answer is `false` and the writer's dedupe still bounds
 * the damage to one row per day.
 */

import { headers } from "next/headers";

export const PREFETCH_HEADERS: ReadonlyArray<readonly [name: string, value: RegExp]> = [
  ["next-router-prefetch", /^1$/],
  ["purpose", /prefetch/i],
  ["sec-purpose", /prefetch/i],
];

/** Pure: decide from a header reader — unit-testable without a request. */
export function prefetchFromHeaders(get: (name: string) => string | null): boolean {
  return PREFETCH_HEADERS.some(([name, value]) => {
    const v = get(name);
    return v !== null && value.test(v);
  });
}

export async function isRouterPrefetch(): Promise<boolean> {
  try {
    const h = await headers();
    return prefetchFromHeaders((name) => h.get(name));
  } catch {
    return false;
  }
}
