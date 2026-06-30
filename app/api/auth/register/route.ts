/**
 * POST /api/auth/register
 *
 * Creates a new user with a Personal Space.
 * All required fields are validated server-side.
 * dateOfBirth is AES-256-GCM encrypted before storage.
 *
 * Body: {
 *   email: string
 *   username: string
 *   password: string
 *   firstName: string
 *   lastName: string
 *   dateOfBirth?: string          // ISO date "YYYY-MM-DD"
 *   employmentStatus?: string
 *   useCase?: string
 *   creditScore?: number          // 300–850, optional
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { possessive } from "@/lib/format";
import { EmploymentStatus, UseCase, SpaceMemberRole } from "@prisma/client";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      email,
      username,
      password,
      firstName,
      lastName,
      dateOfBirth,
      employmentStatus,
      useCase,
      creditScore,
    } = body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!email || !EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "Valid email is required." }, { status: 400 });
    }
    if (!username || !USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3–30 characters (letters, numbers, underscores only)." },
        { status: 400 }
      );
    }
    if (!password || password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });
    }
    if (!firstName?.trim() || !lastName?.trim()) {
      return NextResponse.json({ error: "First and last name are required." }, { status: 400 });
    }
    if (creditScore !== undefined && (typeof creditScore !== "number" || creditScore < 300 || creditScore > 850)) {
      return NextResponse.json({ error: "Credit score must be between 300 and 850." }, { status: 400 });
    }

    const normalizedEmail    = email.toLowerCase().trim();
    const normalizedUsername = username.toLowerCase().trim();

    // ── Uniqueness checks ─────────────────────────────────────────────────────
    const [emailTaken, usernameTaken] = await Promise.all([
      db.user.findUnique({ where: { email: normalizedEmail },    select: { id: true } }),
      db.user.findUnique({ where: { username: normalizedUsername }, select: { id: true } }),
    ]);
    if (emailTaken)    return NextResponse.json({ error: "An account with that email already exists." },    { status: 409 });
    if (usernameTaken) return NextResponse.json({ error: "That username is already taken." }, { status: 409 });

    // ── Hash password + encrypt DOB ───────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);
    const dateOfBirthEncrypted = dateOfBirth ? encryptWithPurpose(dateOfBirth, EncryptionPurpose.DATE_OF_BIRTH) : undefined;

    // ── Create user + space atomically ───────────────────────────────────
    const user = await db.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email:                normalizedEmail,
          username:             normalizedUsername,
          name:                 `${firstName.trim()} ${lastName.trim()}`,
          firstName:            firstName.trim(),
          lastName:             lastName.trim(),
          dateOfBirthEncrypted: dateOfBirthEncrypted ?? null,
          employmentStatus:     (employmentStatus as EmploymentStatus) ?? null,
          useCase:              (useCase as UseCase) ?? null,
          passwordHash,
        },
      });

      const space = await tx.space.create({
        data: {
          name: `${possessive(firstName.trim())} Space`,
          type: "PERSONAL",
        },
      });

      await tx.spaceMember.create({
        data: {
          userId:      newUser.id,
          spaceId: space.id,
          role:        SpaceMemberRole.OWNER,
        },
      });

      // Set the personal space as the user's default landing space.
      await tx.user.update({
        where: { id: newUser.id },
        data:  { preferredSpaceId: space.id },
      });

      await tx.aiAgent.create({
        data: {
          spaceId: space.id,
          name:        `${possessive(firstName.trim())} Financial Agent`,
        },
      });

      // Optional credit score seed
      if (typeof creditScore === "number") {
        await tx.creditScore.create({
          data: {
            userId: newUser.id,
            score:  creditScore,
            source: "manual",
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId:      newUser.id,
          spaceId: space.id,
          action:      "REGISTER",
          metadata:    { email: normalizedEmail, username: normalizedUsername },
        },
      });

      return newUser;
    });

    return NextResponse.json({ success: true, userId: user.id }, { status: 201 });
  } catch (err) {
    console.error("[register] error:", err);
    return NextResponse.json({ error: "Registration failed. Please try again." }, { status: 500 });
  }
}
