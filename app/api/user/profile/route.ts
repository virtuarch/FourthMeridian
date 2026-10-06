/**
 * GET  /api/user/profile  — returns current user's profile
 * PATCH /api/user/profile  — updates profile fields
 *
 * Updatable fields: username, firstName, lastName, employmentStatus, useCase, dateOfBirth
 * dateOfBirth is AES-256-GCM encrypted before storage.
 */

import { NextRequest, NextResponse } from "next/server";
import { isUsernameAvailable } from "@/lib/users/availability";
import { withTenantDb } from "@/lib/db/tenant-context";
import { parseReportingCurrencyInput } from "@/lib/spaces/reporting-currency";
import { parseDefaultSpaceInput, isEligibleDefaultSpace } from "@/lib/spaces/default-space";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { EmploymentStatus, UseCase } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { followedPersonalSpaceName } from "@/lib/spaces/personal-space-name";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

// OPS-3 S3 — an IANA zone is valid iff the runtime's Intl accepts it.
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const [user, err] = await requireUser();
  if (err) return err;

  // RLS slice A — their own row, as them.
  const dbUser = await withTenantDb(user.id, (tx) => tx.user.findUnique({
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
  })) as {
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
  const { username, firstName, lastName, employmentStatus, useCase, dateOfBirth, preferredSpaceId, reportingCurrency, timezone } = body;

  // ── Validate username if provided ─────────────────────────────────────────
  if (username !== undefined) {
    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3–30 characters (letters, numbers, underscores only)." },
        { status: 400 }
      );
    }

    // RLS-13 — a DEPLOYMENT-WIDE question, asked through a capability that can
    // only answer this one. fm_app's `User` policy is `id = current_fm_user_id()`,
    // so the tenant role would report every name as free; rather than hand this
    // route a client that can read every User row, it gets a function that
    // returns a boolean and nothing else.
    const free = await isUsernameAvailable(username, user.id);
    if (!free) return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
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

  // OPS-3 S3 — the user's IANA timezone (Settings → Preferences). Validated by
  // asking Intl itself (the runtime IS the timezone authority — no hand-rolled
  // allowlist to drift). Empty string / null clears back to "never set".
  if (timezone !== undefined) {
    if (timezone === null || timezone === "") {
      data.timezone = null;
    } else if (typeof timezone === "string" && isValidTimezone(timezone)) {
      data.timezone = timezone;
    } else {
      return NextResponse.json({ error: "Unknown timezone." }, { status: 400 });
    }
  }

  // The Default Space is a PREFERENCE (lib/spaces/default-space.ts): this writes
  // the caller's own User row and nothing else — no membership, no visibility.
  // `""` and `null` both clear it (the Preferences picker sends `""` for
  // "Personal Space (default)"; treating that as a Space id is what told the
  // owner on Preview they were "Not a member" of the Space they were returning
  // to). A named Space must be one the resolver would actually land on.
  if (preferredSpaceId  !== undefined) {
    const parsed = parseDefaultSpaceInput(preferredSpaceId);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    if (parsed.spaceId !== null) {
      const targetId = parsed.spaceId;
      // Their OWN membership, so the tenant role answers it.
      const eligible = await withTenantDb(user.id, (tx) => isEligibleDefaultSpace(tx, user.id, targetId));
      if (!eligible) {
        return NextResponse.json({ error: "Not a member of that Space" }, { status: 403 });
      }
    }
    data.preferredSpaceId = parsed.spaceId;
  }

  // Keep display name in sync
  const firstForName = firstName ?? undefined;
  const lastForName  = lastName  ?? undefined;
  if (firstForName || lastForName) {
    const current = await withTenantDb(user.id, (tx) => tx.user.findUnique({
      where: { id: user.id },
      select: { firstName: true, lastName: true },
    }));
    const newFirst = (firstForName ?? current?.firstName ?? "").trim();
    const newLast  = (lastForName  ?? current?.lastName  ?? "").trim();
    if (newFirst || newLast) data.name = `${newFirst} ${newLast}`.trim();
  }

  // The update and its audit row in ONE tenant transaction: nothing sits between
  // them, so the shortest coherent operation is both of them together.
  const updated = await withTenantDb(user.id, async (tx) => {
    const previousFirstName = data.firstName !== undefined
      ? (await tx.user.findUnique({ where: { id: user.id }, select: { firstName: true } }))?.firstName ?? null
      : null;
    const row = await tx.user.update({
      where: { id: user.id },
      data,
      select: { username: true, firstName: true, lastName: true, name: true },
    });
    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: "PROFILE_UPDATE",
        metadata: { fields: Object.keys(data).filter((k) => k !== "dateOfBirthEncrypted") },
      },
    });
    // The Personal Space's GENERATED name follows a first-name correction
    // (lib/spaces/personal-space-name.ts); a name the owner chose is never
    // touched. Only Spaces this user OWNS, in the same transaction, audited as
    // the Space update it is.
    if (data.firstName !== undefined) {
      const owned = await tx.space.findMany({
        where:  { type: "PERSONAL", members: { some: { userId: user.id, role: "OWNER", status: "ACTIVE" } } },
        select: { id: true, name: true },
      });
      for (const space of owned) {
        const renamed = followedPersonalSpaceName(space.name, previousFirstName, data.firstName);
        if (!renamed) continue;
        await tx.space.update({ where: { id: space.id }, data: { name: renamed } });
        await tx.auditLog.create({
          data: {
            userId: user.id, spaceId: space.id, action: "SPACE_UPDATE",
            metadata: { name: { from: space.name, to: renamed }, reason: "generated name follows first name" },
          },
        });
      }
    }
    return row;
  }) as { username: string | null; firstName: string | null; lastName: string | null; name: string | null };

  return NextResponse.json({ success: true, username: updated.username, name: updated.name });
}
