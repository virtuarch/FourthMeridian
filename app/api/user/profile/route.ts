/**
 * GET  /api/user/profile  — returns current user's profile
 * PATCH /api/user/profile  — updates profile fields
 *
 * Updatable fields: username, firstName, lastName, employmentStatus, useCase, dateOfBirth
 * dateOfBirth is AES-256-GCM encrypted before storage.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { EmploymentStatus, UseCase } from "@prisma/client";
import { requireUser } from "@/lib/session";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  const dbUser = await db.user.findUnique({
    where:  { id: user.id },
    select: {
      email: true, username: true,
      firstName: true, lastName: true,
      employmentStatus: true, useCase: true,
      // DOB is encrypted — return a flag so the client knows if it's set
      dateOfBirthEncrypted: true,
      preferredSpaceId: true,
      reportingCurrency: true, // MC1 Phase 4 Slice 2 — user default (copy-once seed)
    },
  }) as {
    email: string; username: string | null; firstName: string | null;
    lastName: string | null; employmentStatus: string | null; useCase: string | null;
    dateOfBirthEncrypted: string | null; preferredSpaceId: string | null;
    reportingCurrency: string;
  } | null;

  if (!dbUser) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    email:                dbUser.email,
    username:             dbUser.username             ?? "",
    firstName:            dbUser.firstName            ?? "",
    lastName:             dbUser.lastName             ?? "",
    employmentStatus:     dbUser.employmentStatus     ?? "",
    useCase:              dbUser.useCase              ?? "",
    hasDob:               !!dbUser.dateOfBirthEncrypted,
    preferredSpaceId: dbUser.preferredSpaceId ?? null,
    reportingCurrency:    dbUser.reportingCurrency ?? "USD",
  });
}

export async function PATCH(req: NextRequest) {
  const [user, err] = await requireUser();
  if (err) return err;

  const body = await req.json();
  const { username, firstName, lastName, employmentStatus, useCase, dateOfBirth, preferredSpaceId, reportingCurrency } = body;

  // ── Validate username if provided ─────────────────────────────────────────
  if (username !== undefined) {
    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3–30 characters (letters, numbers, underscores only)." },
        { status: 400 }
      );
    }

    const taken = await db.user.findFirst({
      where: { username: username.toLowerCase(), NOT: { id: user.id } },
      select: { id: true },
    });
    if (taken) return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
  }

  // ── Build update payload ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};

  if (username              !== undefined) data.username              = username.toLowerCase().trim();
  if (firstName             !== undefined) data.firstName             = firstName.trim();
  if (lastName              !== undefined) data.lastName              = lastName.trim();
  if (employmentStatus      !== undefined) data.employmentStatus      = employmentStatus as EmploymentStatus || null;
  if (useCase               !== undefined) data.useCase               = useCase as UseCase || null;
  if (dateOfBirth           !== undefined) data.dateOfBirthEncrypted  = dateOfBirth ? encryptWithPurpose(dateOfBirth, EncryptionPurpose.DATE_OF_BIRTH) : null;
  // MC1 Phase 4 Slice 2 (plan D-3) — the user's DEFAULT reporting currency.
  // Copy-once seed for NEW Spaces only (POST /api/spaces); never re-denominates
  // existing Spaces. Allowlist-validated: FX_BASE + SUPPORTED_QUOTES, 400 on
  // anything else (same rule as the Space PATCH).
  if (reportingCurrency !== undefined) {
    const parsed = parseReportingCurrencyInput(reportingCurrency);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    data.reportingCurrency = parsed.value;
  }

  if (preferredSpaceId  !== undefined) {
    // Validate that user is actually a member of this space (or null to clear)
    if (preferredSpaceId !== null) {
      const membership = await db.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: preferredSpaceId, userId: user.id } },
        select: { status: true },
      });
      if (!membership || membership.status !== "ACTIVE") {
        return NextResponse.json({ error: "Not a member of that Space" }, { status: 403 });
      }
    }
    data.preferredSpaceId = preferredSpaceId;
  }

  // Keep display name in sync
  const firstForName = firstName ?? undefined;
  const lastForName  = lastName  ?? undefined;
  if (firstForName || lastForName) {
    const current = await db.user.findUnique({
      where: { id: user.id },
      select: { firstName: true, lastName: true },
    });
    const newFirst = (firstForName ?? current?.firstName ?? "").trim();
    const newLast  = (lastForName  ?? current?.lastName  ?? "").trim();
    if (newFirst || newLast) data.name = `${newFirst} ${newLast}`.trim();
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
    select: { username: true, firstName: true, lastName: true, name: true },
  }) as { username: string | null; firstName: string | null; lastName: string | null; name: string | null };

  await db.auditLog.create({
    data: {
      userId: user.id,
      action: "PROFILE_UPDATE",
      metadata: { fields: Object.keys(data).filter((k) => k !== "dateOfBirthEncrypted") },
    },
  });

  return NextResponse.json({ success: true, username: updated.username, name: updated.name });
}
