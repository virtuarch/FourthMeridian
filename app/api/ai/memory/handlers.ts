/**
 * app/api/ai/memory/handlers.ts
 *
 * THE USER'S OWN MEMORY: SEE IT, STOP IT, ERASE IT — the three handlers, with
 * every dependency injected so ownership is provable without a database.
 *
 * ⚠️ THE CHAT ROUTE'S RULE, VERBATIM (`app/api/ai/chat/route.ts`).
 *   • `requireUser()`, then a per-user rate limit.
 *   • `resolveSpaceContext(user.id, spaceId)` and **403 when the named Space does
 *     not come back as itself** — the fallback that is right for a stale cookie
 *     is wrong here too: it would list, retire or erase memory in a Space the
 *     user did not name.
 *   • The scope is `{ spaceId: ctx.spaceId, ownerUserId: user.id }` and the store
 *     applies all of it to every lookup. Another member's id is a **404**, never a
 *     403: existence is not disclosed.
 *   • NO ROUTE TAKES A USER ID. A Space owner or admin cannot list, retire or
 *     erase another member's memory, and there is no SYSTEM_ADMIN bypass of
 *     ownership. Any member who can reach the Space manages THEIR OWN memory,
 *     whatever their role.
 *
 * ⚠️ WHAT THIS SURFACE DELIBERATELY CANNOT DO: create memory, edit it, or "use
 * it now". A button that ran a remembered rule would make memory activate a
 * scenario. To change something, the user tells the assistant, or deletes it and
 * says it again.
 */

import { NextResponse } from 'next/server';
import type { MemoryScope, OwnMemoryItem, OwnMutation } from '@/lib/ai/conversation/memory-store';

export interface MemoryApiDeps {
  requireUser(): Promise<[{ id: string; role?: string }, null] | [null, NextResponse]>;
  /** Null when allowed; a ready 429 otherwise. */
  limit(userId: string): Promise<NextResponse | null>;
  /** Resolves the Space the user can actually reach — which may NOT be the one they named. */
  resolveSpace(userId: string, spaceId: string): Promise<{ spaceId: string }>;
  today(): string;
  list(scope: MemoryScope, todayISO: string): Promise<OwnMemoryItem[]>;
  retire(scope: MemoryScope, id: string, statedAt: string): Promise<OwnMutation>;
  erase(scope: MemoryScope, id: string): Promise<{ ok: true; erased: number; kind: string } | { ok: false; why: 'NOT_FOUND' }>;
  /** A CONTENT-FREE record that an erasure happened. Never what was erased. */
  audit(event: { userId: string; spaceId: string; kind: string; versionsErased: number }): Promise<void>;
}

const say = (error: string, status: number) => NextResponse.json({ error }, { status });

export const SAY = {
  noSpace:   'Say which Space this is about.',
  forbidden: 'You don’t have access to that Space.',
  notFound:  'That isn’t something remembered for you here.',
  cannotRetire: 'This one can’t be switched off — it can only be deleted.',
  conflict:  'This was changed a moment ago. Refresh and try again.',
  malformed: 'That request couldn’t be read.',
  failed:    'Something went wrong. Nothing was changed.',
} as const;

/** The sections the panel shows. Decided here, once, so the page only renders. */
export interface MemoryListing {
  remembered:      OwnMemoryItem[];
  planningFigures: OwnMemoryItem[];
  projections:     OwnMemoryItem[];
  lapsed:          OwnMemoryItem[];
  unreadable:      OwnMemoryItem[];
}

export function groupListing(items: readonly OwnMemoryItem[]): MemoryListing {
  const out: MemoryListing = { remembered: [], planningFigures: [], projections: [], lapsed: [], unreadable: [] };
  for (const item of items) {
    if (item.state === 'UNREADABLE') out.unreadable.push(item);
    else if (item.class === 'PROJECTION') out.projections.push(item);
    else if (item.state === 'LAPSED') out.lapsed.push(item);
    else if (item.class === 'BASELINE') out.planningFigures.push(item);
    else out.remembered.push(item);
  }
  return out;
}

/** Auth → limit → the named Space, as itself → the scope. Or the refusal. */
async function scopeFor(
  deps: MemoryApiDeps, spaceId: string | null,
): Promise<{ scope: MemoryScope } | { refusal: NextResponse }> {
  const [user, authErr] = await deps.requireUser();
  if (authErr) return { refusal: authErr };
  const limited = await deps.limit(user.id);
  if (limited) return { refusal: limited };
  if (!spaceId) return { refusal: say(SAY.noSpace, 400) };
  let resolved: { spaceId: string };
  try {
    resolved = await deps.resolveSpace(user.id, spaceId);
  } catch {
    return { refusal: say(SAY.failed, 503) };
  }
  // ⚠️ RE-RESOLVED, NEVER ACCEPTED. A named Space that does not come back as itself is a refusal.
  if (resolved.spaceId !== spaceId) return { refusal: say(SAY.forbidden, 403) };
  return { scope: { spaceId: resolved.spaceId, ownerUserId: user.id } };
}

export async function listMemory(deps: MemoryApiDeps, spaceId: string | null): Promise<NextResponse> {
  const s = await scopeFor(deps, spaceId);
  if ('refusal' in s) return s.refusal;
  try {
    return NextResponse.json(groupListing(await deps.list(s.scope, deps.today())));
  } catch {
    return say(SAY.failed, 500);
  }
}

export async function retireMemoryItem(
  deps: MemoryApiDeps, id: string, body: unknown,
): Promise<NextResponse> {
  const b = (body && typeof body === 'object' ? body : {}) as { spaceId?: unknown; action?: unknown };
  if (b.action !== 'retire') return say(SAY.malformed, 400);
  const s = await scopeFor(deps, typeof b.spaceId === 'string' ? b.spaceId : null);
  if ('refusal' in s) return s.refusal;
  try {
    const result = await deps.retire(s.scope, id, deps.today());
    if (!result.ok) {
      return result.why === 'NOT_FOUND' ? say(SAY.notFound, 404)
        : result.why === 'CONFLICT' ? say(SAY.conflict, 409) : say(SAY.cannotRetire, 422);
    }
    return NextResponse.json(groupListing(await deps.list(s.scope, deps.today())));
  } catch (err) {
    // `supersedesId` is unique: two requests retiring one version cannot both win.
    if ((err as { code?: string })?.code === 'P2002') return say(SAY.conflict, 409);
    return say(SAY.failed, 500);
  }
}

export async function eraseMemoryItem(
  deps: MemoryApiDeps, id: string, spaceId: string | null,
): Promise<NextResponse> {
  const s = await scopeFor(deps, spaceId);
  if ('refusal' in s) return s.refusal;
  try {
    const result = await deps.erase(s.scope, id);
    if (!result.ok) return say(SAY.notFound, 404);
    // Best-effort and content-free: an audit failure must not resurrect what the user erased.
    await deps.audit({ userId: s.scope.ownerUserId, spaceId: s.scope.spaceId, kind: result.kind, versionsErased: result.erased })
      .catch(() => undefined);
    return NextResponse.json(groupListing(await deps.list(s.scope, deps.today())));
  } catch {
    return say(SAY.failed, 500);
  }
}
