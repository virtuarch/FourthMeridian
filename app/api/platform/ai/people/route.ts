/**
 * POST /api/platform/ai/people  (Platform AI — the @ people picker search; owner 2026-11-10, S2 09fc P1–P6)
 *
 * `{ q }` ⇒ `{ matches: [{ opaqueRef, label }] }` — at most 8 customers whose USERNAME or EMAIL LOCAL PART
 * starts with q (3–64 of [a-z0-9._+-], case-insensitive). The label goes ONLY to this operator's response:
 * the composer sends the chip token `[[cust:<opaqueRef>]]` (authz/people-chip.ts), never the label.
 * A POST, so the query never sits in a URL or an access log.
 *
 * GATE CHAIN (every refusal before any customer read):
 *   0. PLATFORM_AI_ENABLED off, or the customers pack flag off   → 404 NOT_AVAILABLE
 *   1. requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ"), recorded → 401 / 403
 *   2. P5 subject-lookup authority, FRESH (authz/people.server.ts platformAiP5Authority: the pack, a real
 *      CUSTOMER_SUCCESS grant for this operator with the CS tier; never break-glass)  → 403
 *   3. the #352 per-operator mutation limiter                    → 429
 *   4. the body: exactly { q }, normalised (authz/people.ts)     → 400
 *   5. searchPeople: the SHARED P5 limiter, the bounded read, the audit row first, the timing floor —
 *      LIMITED / UNAVAILABLE / a failed audit / no match ⇒ the ONE uniform `{ matches: [] }` (200).
 * Never logs the query or a label.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireFreshPlatformAccess } from "@/lib/platform/authorize";
import { env } from "@/lib/env";
import { limitPlatformMutation } from "@/lib/platform/mutation-rate-limit";
import { platformAiPackEnabled } from "@/lib/platform/intelligence/ai/engine/router";
import { parsePeopleBody, searchPeople } from "@/lib/platform/intelligence/ai/authz/people";
import { platformAiP5Authority, platformAiPeopleSearchDeps } from "@/lib/platform/intelligence/ai/authz/people.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const NOT_AVAILABLE = { error: "Not available.", code: "NOT_AVAILABLE" } as const;

export async function POST(req: NextRequest) {
  if (!env.isPlatformAiEnabled || !platformAiPackEnabled("customers")) return NextResponse.json(NOT_AVAILABLE, { status: 404, headers: NO_STORE });
  // The CS area's own guard, FRESH and recorded (session, grant, operator 2FA, live revocation).
  const [auth, err] = await requireFreshPlatformAccess("CUSTOMER_SUCCESS", "READ");
  if (err) return err;
  // P5 authority on top: the customers pack, I-7 (a real grant, this operator, never break-glass) and the CS tier.
  if (!(await platformAiP5Authority(auth.user.id))) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  const limited = await limitPlatformMutation(auth.user.id, "platform-ai-people");
  if (limited) return limited;
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const q = parsePeopleBody(body);
  if (q === null) return NextResponse.json({ error: "Send { q: 3–64 letters, digits or . _ + - }.", code: "VALIDATION" }, { status: 400, headers: NO_STORE });
  const res = await searchPeople(q, platformAiPeopleSearchDeps(auth.user.id));
  return NextResponse.json({ matches: res.matches }, { status: 200, headers: NO_STORE });
}
