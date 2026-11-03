/**
 * lib/platform/mutation-rate-limit.ts — S2 P8 #5
 *
 * THE DEFAULT PER-OPERATOR LIMIT FOR A PLATFORM MUTATION. Every POST / PUT /
 * PATCH / DELETE under app/api/platform/** calls a limiter; a route with no
 * stricter limit of its own calls this one. It is the house limiter
 * (`limitByUser`, lib/rate-limit.ts) with a conservative default, keyed by the
 * authenticated operator's user id — never by IP — and scoped per route, so one
 * busy screen cannot starve another. A hit is the limiter's own 429 response,
 * the same shape every limited route returns.
 *
 * Pinned by app/api/platform/mutating-route-limits.test.ts: a mutating platform
 * handler without a limiter call (or an allowlisted reason) fails the build.
 */
import type { NextResponse } from "next/server";
import { limitByUser, type RateLimitConfig } from "@/lib/rate-limit";

/** 30 mutations per operator per minute per route. */
export const PLATFORM_MUTATION_LIMIT: Readonly<RateLimitConfig> = Object.freeze({ limit: 30, windowSec: 60 });

/** The bucket-name prefix, so these buckets are recognisable in the RateLimit table. */
export const PLATFORM_MUTATION_BUCKET_PREFIX = "platform-mutation:";

/**
 * Apply the default limit to one platform mutation. Call it right after the
 * route's access guard, with the guard's authenticated user id; return the
 * response when it is non-null.
 */
export function limitPlatformMutation(operatorUserId: string, route: string): Promise<NextResponse | null> {
  return limitByUser(operatorUserId, `${PLATFORM_MUTATION_BUCKET_PREFIX}${route}`, PLATFORM_MUTATION_LIMIT);
}
