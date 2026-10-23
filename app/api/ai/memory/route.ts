/**
 * GET /api/ai/memory?spaceId=… — what Fourth Meridian remembers for THIS user in
 * THIS Space, in plain language, grouped for the Memory panel.
 *
 * The rules (auth, rate limit, 403 on a Space that does not resolve to itself, the
 * `{spaceId, ownerUserId}` scope, no user id anywhere) live in `handlers.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { listMemory } from './handlers';
import { memoryApiDeps } from './deps';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  return listMemory(memoryApiDeps, req.nextUrl.searchParams.get('spaceId'));
}
