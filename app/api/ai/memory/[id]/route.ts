/**
 * PATCH  /api/ai/memory/[id]  { spaceId, action: "retire" } — stop using an item (a tombstone row; history kept).
 * DELETE /api/ai/memory/[id]?spaceId=…                       — erase the item AND its whole history.
 *
 * `[id]` is looked up under `{ id, spaceId, ownerUserId }` from the session, so
 * another member's id is a 404. The rules live in `../handlers.ts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { retireMemoryItem, eraseMemoryItem, SAY } from '../handlers';
import { memoryApiDeps } from '../deps';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: SAY.malformed }, { status: 400 });
  }
  return retireMemoryItem(memoryApiDeps, id, body);
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params;
  return eraseMemoryItem(memoryApiDeps, id, req.nextUrl.searchParams.get('spaceId'));
}
