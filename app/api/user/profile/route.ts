/**
 * GET  /api/user/profile  — returns current user's profile
 * PATCH /api/user/profile  — updates profile fields
 *
 * Updatable fields: username, firstName, lastName, employmentStatus, useCase, dateOfBirth
 * dateOfBirth is AES-256-GCM encrypted before storage.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/plaid/encryption";
import { EmploymentStatus, UseCase } from "@prisma/client";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const user = await db.user.findUnique({
    where:  { id: session.user.id },
    select: {
      email: true, username: true,
      firstName: true, lastName: true,
      employmentStatus: true, useCase: true,
      // DOB is encrypted — return a flag so the client knows if it's set
      dateOfBirthEncrypted: true,
    },
  });

  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    email:            user.email,
    username:         user.username         ?? "",
    firstName:        user.firstName        ?? "",
    lastName:         user.lastName         ?? "",
    employmentStatus: user.employmentStatus ?? "",
    useCase:          user.useCase          ?? "",
    hasDob:           !!user.dateOfBirthEncrypted,
  });
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { username, firstName, lastName, employmentStatus, useCase, dateOfBirth } = body;

  // ── Validate username if provided ─────────────────────────────────────────
  if (username !== undefined) {
    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3–30 characters (letters, numbers, underscores only)." },
        { status: 400 }
      );
    }

    const taken = await db.user.findFirst({
      where: { username: username.toLowerCase(), NOT: { id: session.user.id } },
      select: { id: true },
    });
    if (taken) return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
  }

  // ── Build update payload ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};

  if (username         !== undefined) data.username         = username.toLowerCase().trim();
  if (firstName        !== undefined) data.firstName        = firstName.trim();
  if (lastName         !== undefined) data.lastName         = lastName.trim();
  if (employmentStatus !== undefined) data.employmentStatus = employmentStatus as EmploymentStatus || null;
  if (useCase          !== undefined) data.useCase          = useCase as UseCase || null;
  if (dateOfBirth      !== undefined) data.dateOfBirthEncrypted = dateOfBirth ? encrypt(dateOfBirth) : null;

  // Keep display name in sync
  const firstForName = firstName ?? undefined;
  const lastForName  = lastName  ?? undefined;
  if (firstForName || lastForName) {
    const current = await db.user.findUnique({
      where: { id: session.user.id },
      select: { firstName: true, lastName: true },
    });
    const newFirst = (firstForName ?? current?.firstName ?? "").trim();
    const newLast  = (lastForName  ?? current?.lastName  ?? "").trim();
    if (newFirst || newLast) data.name = `${newFirst} ${newLast}`.trim();
  }

  const updated = await db.user.update({
    where: { id: session.user.id },
    data,
    select: { username: true, firstName: true, lastName: true, name: true },
  });

  await db.auditLog.create({
    data: {
      userId: session.user.id,
      action: "PROFILE_UPDATE",
      metadata: { fields: Object.keys(data).filter((k) => k !== "dateOfBirthEncrypted") },
    },
  });

  return NextResponse.json({ success: true, username: updated.username, name: updated.name });
}
