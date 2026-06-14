/**
 * POST /api/auth/pre-login
 *
 * Step-1 of the two-step login flow.
 * Verifies email/username + password and tells the client whether TOTP is required.
 * Does NOT create a session — that happens via NextAuth signIn() in step 2.
 *
 * Returns:
 *   { ok: false }                        — bad credentials
 *   { ok: true, totpRequired: false }    — login can complete in one step
 *   { ok: true, totpRequired: true }     — TOTP screen must be shown
 *
 * Security notes:
 *   - Timing-safe: always runs bcrypt even when user is not found (dummy hash).
 *   - Does NOT distinguish "user not found" from "wrong password" to avoid enumeration.
 *   - TODO: add rate limiting (e.g. 10 attempts/min per IP) before public deployment.
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

// Dummy hash used when the user is not found, to keep timing consistent.
const DUMMY_HASH =
  "$2a$12$Jb7jQimXuPj.v5R5hjZ.G.7F4.D3R1bBO4a0p6Y6f3jC2E4V6Uuze";

export async function POST(req: NextRequest) {
  try {
    const body       = await req.json();
    const identifier = (body.identifier as string | undefined)?.toLowerCase().trim() ?? "";
    const password   = (body.password   as string | undefined) ?? "";

    if (!identifier || !password) {
      return NextResponse.json({ ok: false }, { status: 400 });
    }

    const user = await db.user.findFirst({
      where: {
        OR: [{ email: identifier }, { username: identifier }],
      },
      select: { id: true, passwordHash: true, totpEnabled: true },
    });

    // Always run bcrypt to prevent timing-based user enumeration
    const hash  = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hash);

    if (!valid || !user) {
      return NextResponse.json({ ok: false });
    }

    return NextResponse.json({
      ok:           true,
      totpRequired: user.totpEnabled,
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
