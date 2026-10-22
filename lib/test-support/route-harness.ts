/**
 * lib/test-support/route-harness.ts  (TEST-002 / TEST-004)
 *
 * INVOKE A REAL APP-ROUTER HANDLER, AS A REAL SIGNED-IN USER, WITH NO SERVER.
 *
 *   • `next/headers` — `cookies()` / `headers()` are replaced (on the module's
 *     own exports object, which both next-auth's `getServerSession` and
 *     lib/session.ts read at CALL time) with the request currently being
 *     handled, carried in an AsyncLocalStorage so concurrent invocations in a
 *     race test each see their own request.
 *   • Sessions — `signIn()` writes a real `UserSession` row into the fake store
 *     and mints a real NextAuth JWT (next-auth/jwt `encode`, the app secret).
 *     The handler then authenticates through the UNMODIFIED chain:
 *     getServerSession → lib/auth.ts jwt/session callbacks → session-proof →
 *     revocation check against the store. Nothing about identity is stubbed.
 *   • `invoke()` — calls the exported handler with `(req, { params })` exactly
 *     as Next does and returns status, parsed JSON body and headers.
 *
 * ⚠️ TEST-ONLY.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { authCookiesSecure, sessionCookieName } from "@/lib/auth/session-cookie";
import { clearAllSessions } from "@/lib/session-cache";
import { CLIENT_IP_HEADER_ORDER } from "@/lib/security/client-ip";
import type { FakePrisma } from "./fake-prisma";

const scope = new AsyncLocalStorage<NextRequest>();
let patched = false;

/** Route `next/headers` to the request being handled. Idempotent. */
export function patchNextHeaders(): void {
  if (patched) return;
  const req = createRequire(__filename);
  const nh = req("next/headers") as Record<string, unknown>;
  const current = (): NextRequest => {
    const r = scope.getStore();
    if (!r) throw new Error("route-harness: next/headers read outside invoke()");
    return r;
  };
  nh.cookies = async () => current().cookies;
  nh.headers = async () => current().headers;
  patched = true;
}

export const HOST = "https://app.test.invalid";

/**
 * The client-address header the request carries: the first one in the
 * production extractor's trust order that needs no opt-in (Cloudflare's does).
 * Taken from lib/security/client-ip.ts rather than spelled here, so the harness
 * can never disagree with what the limiter and audit trail actually read.
 */
const IP_HEADER = CLIENT_IP_HEADER_ORDER.find((h) => !h.startsWith("cf-") && !h.includes("vercel"))!;

export interface ReqInit {
  method?: string;
  body?: unknown;
  /** A raw string body (sent as-is). */
  rawBody?: string;
  cookie?: string | null;
  ip?: string;
  headers?: Record<string, string>;
}

export function request(path: string, init: ReqInit = {}): NextRequest {
  const headers: Record<string, string> = {
    host: new URL(HOST).host,
    "x-forwarded-proto": "https",
    [IP_HEADER]: init.ip ?? "203.0.113.10",
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
    ...(init.cookie ? { cookie: init.cookie } : {}),
    ...(init.headers ?? {}),
  };
  const method = init.method ?? (init.body !== undefined || init.rawBody !== undefined ? "POST" : "GET");
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) { body = JSON.stringify(init.body); headers["content-type"] ??= "application/json"; }
  return new NextRequest(new URL(path, HOST), { method, headers, body });
}

export interface Invoked<B = Record<string, unknown>> {
  status: number;
  body: B;
  text: string;
  headers: Headers;
  res: Response;
}

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, unknown>> }) => Promise<Response> | Response;

/** Call `handler(req, { params })` with `next/headers` bound to `req`. */
export async function invoke<B = Record<string, unknown>>(
  handler: unknown, req: NextRequest, params: Record<string, unknown> = {},
): Promise<Invoked<B>> {
  patchNextHeaders();
  const res = await scope.run(req, () => (handler as Handler)(req, { params: Promise.resolve(params) }));
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body: body as B, text, headers: res.headers, res };
}

export interface SignedIn {
  userId: string;
  sessionToken: string;
  sessionId: string;
  cookie: string;
}

/**
 * A live session for `userId`: a UserSession row in the fake store + the JWT
 * NextAuth would have issued for it. `requireTotpSetup` is only the token's
 * HINT — the session callback re-derives the real value from the store.
 */
export async function signIn(
  fake: FakePrisma,
  userId: string,
  opts: { requireTotpSetup?: boolean; userAgent?: string; createdAt?: Date } = {},
): Promise<SignedIn> {
  const user = fake.one("User", { id: userId });
  if (!user) throw new Error(`signIn: no fixture user ${userId}`);
  const sessionToken = randomUUID();
  const row = fake.seed("UserSession", {
    userId, sessionToken, ipAddress: "203.0.113.10", userAgent: opts.userAgent ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt, lastActiveAt: opts.createdAt } : {}),
  });
  const jwt = await encode({
    token: {
      id: userId, role: user.role, username: user.username ?? null, sessionToken,
      requireTotpSetup: opts.requireTotpSetup ?? null, sub: userId,
    } as never,
    secret: process.env.NEXTAUTH_SECRET!,
  });
  return { userId, sessionToken, sessionId: row.id as string, cookie: `${sessionCookieName(authCookiesSecure())}=${jwt}` };
}

/** Drop the 30 s revocation cache so the next request re-reads the store. */
export function freshCache(): void { clearAllSessions(); }

// ── assertions ───────────────────────────────────────────────────────────────
export function makeChecker(title: string) {
  let failures = 0;
  let passes = 0;
  console.log(title);
  return {
    section(name: string) { console.log(`\n${name}`); },
    check(name: string, cond: boolean, detail?: unknown) {
      if (cond) { passes++; console.log(`  ✓ ${name}`); }
      else { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`); }
    },
    /**
     * A DEFECT this suite found and the report records, outside the owner's
     * paths to fix. Never fails the run; says loudly which way it went, so the
     * day it is fixed the line can be promoted to a `check`.
     */
    known(name: string, holdsNow: boolean, ref: string) {
      if (holdsNow) console.log(`  ✓ ${name} (was a known defect: ${ref} — promote this to a check)`);
      else console.warn(`  ⚠ KNOWN DEFECT (${ref}) — ${name}`);
    },
    done() {
      console.log(`\n${passes} passed, ${failures} failed`);
      if (failures > 0) process.exit(1);
      process.exit(0);
    },
  };
}
