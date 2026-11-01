/**
 * lib/analytics/link-exit.ts  (S2-(a) — CONNECTION_LINK_EXITED intake)
 *
 * The body contract and the handler of POST /api/analytics/link-exit, the one
 * request Plaid Link's `onExit` makes so an abandoned or failed link becomes a
 * product event instead of a console line.
 *
 * WHAT THE BROWSER MAY SAY: `{ provider: "PLAID", stage?: string|null,
 * errorCode?: string|null }` and nothing else. `stage` is Plaid's exit
 * `metadata.status`, `errorCode` is `error.error_code`; each is mapped onto a
 * closed vocabulary (lib/analytics/product-events.ts), so a value the list does
 * not know is stored as "OTHER", never as itself. Any other key (an institution
 * name, `error_message`, `display_message`, `link_session_id`, `request_id`, …),
 * a non-string value, a string longer than an enum code, a provider other than
 * PLAID or a body over MAX_LINK_EXIT_BODY_BYTES is refused with 400 / 413 and
 * nothing is written.
 *
 * NEVER BREAKS THE USER ACTION. The caller is a fire-and-forget beacon from a
 * closing Link modal; the analytics write itself fails soft (the writer resolves
 * false and the tenant phase is caught), so an accepted body always answers 204.
 *
 * Pure: the route (app/api/analytics/link-exit/route.ts) wires the real session,
 * limiter and tenant phase; the test drives this with fakes.
 */

import { NextResponse } from "next/server";
import {
  linkExitErrorCode, linkExitStage, recordConnectionLinkExited,
  type LinkExitErrorCode, type LinkExitStage, type ProductEventClient,
} from "@/lib/analytics/product-events";

/** A valid body is ~80 bytes; anything near this is not one. */
export const MAX_LINK_EXIT_BODY_BYTES = 512;
/** The longest raw stage / error code accepted before mapping (Plaid codes are < 50). */
export const MAX_LINK_EXIT_FIELD_CHARS = 64;
/** Per-user limit: a person closes Link a handful of times, not dozens. */
export const LINK_EXIT_RATE_LIMIT = { limit: 20, windowSec: 900 } as const;

const BODY_KEYS: ReadonlySet<string> = new Set(["provider", "stage", "errorCode"]);

export type LinkExitBody = { provider: "PLAID"; stage: LinkExitStage; errorCode: LinkExitErrorCode };

/** Strict parse of the raw body text. `null` = refuse (400). */
export function parseLinkExitBody(text: string): LinkExitBody | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!BODY_KEYS.has(k)) return null;
  if (obj.provider !== "PLAID") return null;
  const field = (v: unknown): boolean =>
    v === undefined || v === null || (typeof v === "string" && v.length <= MAX_LINK_EXIT_FIELD_CHARS);
  if (!field(obj.stage) || !field(obj.errorCode)) return null;
  return { provider: "PLAID", stage: linkExitStage(obj.stage), errorCode: linkExitErrorCode(obj.errorCode) };
}

export interface LinkExitDeps {
  limitByUser(userId: string, name: string, cfg: { limit: number; windowSec: number }): Promise<NextResponse | null>;
  /** Runs `fn` in the caller's tenant phase (withTenantDb in production). */
  withTenant<T>(userId: string, fn: (tx: ProductEventClient) => Promise<T>): Promise<T>;
}

const refuse = (status: number) => NextResponse.json({ error: "Invalid analytics event." }, { status });

/**
 * The handler body. The route authenticates first (`requireUser`, in the route
 * file itself so the route-guard census sees it) and hands the session user in;
 * a missing user is refused here too, so this function is never an open door.
 */
export async function handleLinkExit(
  req: Request,
  user: { id: string } | null,
  deps: LinkExitDeps,
): Promise<NextResponse | Response> {
  if (!user) return refuse(401);

  const limited = await deps.limitByUser(user.id, "analytics-link-exit", LINK_EXIT_RATE_LIMIT);
  if (limited) return limited;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_LINK_EXIT_BODY_BYTES) return refuse(413);
  let text: string;
  try { text = await req.text(); } catch { return refuse(400); }
  if (Buffer.byteLength(text, "utf8") > MAX_LINK_EXIT_BODY_BYTES) return refuse(413);

  const body = parseLinkExitBody(text);
  if (!body) return refuse(400);

  try {
    await deps.withTenant(user.id, (tx) => recordConnectionLinkExited(tx, {
      userId: user.id, provider: body.provider, stage: body.stage, errorCode: body.errorCode,
    }));
  } catch (err) {
    console.warn(`[product-events] CONNECTION_LINK_EXITED not recorded (${err instanceof Error ? err.name : "error"})`);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
