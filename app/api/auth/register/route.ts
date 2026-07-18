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
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { encryptWithPurpose, EncryptionPurpose } from "@/lib/plaid/encryption";
import { hashResetToken } from "@/lib/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { buildVerifyUrl } from "@/lib/email/verify-url";
import { possessive } from "@/lib/format";
import { EmploymentStatus, UseCase, SpaceMemberRole, BetaAccessRequestStatus, Prisma } from "@prisma/client";
import { limitByIp } from "@/lib/rate-limit";
import { getRequestMeta } from "@/lib/api";
import { verifyCaptchaToken } from "@/lib/captcha";
import { AuditAction } from "@/lib/audit-actions";
import { getMinPasswordLength, getRegistrationMode } from "@/lib/platform-settings";
import { validateInvite } from "@/lib/registration-policy";
import { getTemplateForCategory } from "@/lib/space-templates/registry";
import { planTemplateApplication } from "@/lib/space-templates/apply";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

// OPS-1 S2b — email-verification token TTL (mirrors password reset: 1 hour).
const VERIFICATION_TTL_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const limited = await limitByIp(req, "register", { limit: 5, windowSec: 900 });
    if (limited) return limited;

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
      inviteToken,
      captchaToken,
    } = body;

    // ── Registration gate (Wave 1 S2) ─────────────────────────────────────────
    // Read the platform-wide mode BEFORE any field validation so `closed` short-
    // circuits without leaking which fields would have failed. `open` is the
    // ship default (behavior unchanged); `invite_only` requires a valid beta
    // invite (validated below, after the email is normalized).
    const registrationMode = await getRegistrationMode();
    if (registrationMode === "closed") {
      return NextResponse.json(
        { error: "Registration is currently closed." },
        { status: 403 },
      );
    }

    // ── CAPTCHA (Wave 2 ⑥) ─────────────────────────────────────────────────────
    // Always verified when configured (registration is a top spam target).
    // Env-gated: no TURNSTILE_SECRET_KEY ⇒ verifyCaptchaToken returns true, so
    // dev/test and unconfigured deploys register unchanged. Checked before any
    // field validation or DB work so a bot burns nothing past this point.
    const captchaOk = await verifyCaptchaToken(captchaToken, getRequestMeta(req).ip);
    if (!captchaOk) {
      return NextResponse.json(
        { error: "CAPTCHA verification failed. Please try again." },
        { status: 400 },
      );
    }

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
    // SEC-4 — enforce the admin-configurable min length, not a hardcoded 8.
    const minPasswordLength = await getMinPasswordLength();
    if (!password || password.length < minPasswordLength) {
      return NextResponse.json({ error: `Password must be at least ${minPasswordLength} characters.` }, { status: 400 });
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

    // ── Invite-only redemption gate (Wave 1 S3) ───────────────────────────────
    // In invite_only mode a valid, unexpired, APPROVED beta invite is required,
    // and it is EMAIL-BOUND: the registration email must equal the address the
    // invite was issued to (the invite proves inbox ownership). The token is
    // hashed before lookup (same SHA-256 helper as password-reset). The row is
    // consumed atomically inside the $transaction below (status → REDEEMED).
    let betaRequestId: string | null = null;
    const invitedFlow = registrationMode === "invite_only";
    if (invitedFlow) {
      if (!inviteToken || typeof inviteToken !== "string") {
        return NextResponse.json(
          { error: "An invite is required to register. Request access to receive one." },
          { status: 403 },
        );
      }
      // ONE authoritative invite validator (lib/registration-policy.ts) — the same
      // one the public register page consults, so the gate can never disagree
      // with what the visitor was shown.
      const invite = await validateInvite(inviteToken);
      if (!invite.valid) {
        return NextResponse.json(
          { error: "This invite is invalid or has expired. Please request access again." },
          { status: 403 },
        );
      }
      // Email-bound: the invite is single-inbox. A mismatch is rejected outright.
      if (invite.email !== normalizedEmail) {
        return NextResponse.json(
          { error: "This invite was issued to a different email address." },
          { status: 403 },
        );
      }
      betaRequestId = invite.requestId;
    }

    // ── Hash password + encrypt DOB ───────────────────────────────────────────
    const passwordHash = await bcrypt.hash(password, 12);
    const dateOfBirthEncrypted = dateOfBirth ? encryptWithPurpose(dateOfBirth, EncryptionPurpose.DATE_OF_BIRTH) : undefined;

    // ── Email-verification token (OPS-1 S2b) ──────────────────────────────────
    // New signups start UNVERIFIED (emailVerifiedAt stays null). Only the hash
    // is persisted; rawVerificationToken lives solely in the outbound email.
    // STORED-BUT-NOT-CONSUMED: no verify/resend route or login gate reads these
    // yet — this slice only proves the email is sent and the state is stored.
    const rawVerificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpiry   = new Date(Date.now() + VERIFICATION_TTL_MS);

    // ── Create user + space atomically ───────────────────────────────────
    const user = await db.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          email:                   normalizedEmail,
          username:                normalizedUsername,
          name:                    `${firstName.trim()} ${lastName.trim()}`,
          firstName:               firstName.trim(),
          lastName:                lastName.trim(),
          dateOfBirthEncrypted:    dateOfBirthEncrypted ?? null,
          employmentStatus:        (employmentStatus as EmploymentStatus) ?? null,
          useCase:                 (useCase as UseCase) ?? null,
          passwordHash,
          // Invited signups are pre-verified: the invite email already proved
          // inbox ownership, so we skip the whole verification leg (no token
          // stored, no verification email sent below). Uninvited signups start
          // UNVERIFIED with a token as before.
          ...(invitedFlow
            ? { emailVerifiedAt: new Date() }
            : {
                emailVerificationToken:  hashResetToken(rawVerificationToken),
                emailVerificationExpiry: verificationExpiry,
              }),
        },
      });

      // SP-2A-3 — Personal Spaces are template-backed from birth: materialize
      // the hidden `personal` template (lib/space-templates, SP-1) into
      // SpaceDashboardSection rows, mirroring the POST /api/spaces
      // materialization pattern. The planner is pure/synchronous; against an
      // empty Space its plan equals getPresetsForCategory("PERSONAL")
      // (parity-tested). Sections stay dormant on the Personal UI until the
      // SP-2A-4 shell swap — this slice changes the data model only.
      const personalTemplate = getTemplateForCategory("PERSONAL");
      if (!personalTemplate) {
        // Static registry invariant (guarded by lib/space-templates tests);
        // throwing aborts the transaction rather than minting a sectionless
        // Personal Space.
        throw new Error("space-templates registry has no PERSONAL template");
      }
      const plannedSections = planTemplateApplication(
        personalTemplate,
        new Set<string>()
      ).sectionsToCreate;

      const space = await tx.space.create({
        data: {
          name: `${possessive(firstName.trim())} Space`,
          type: "PERSONAL",
          dashboardSections: {
            create: plannedSections.map((s) => ({
              key:     s.key,
              label:   s.label,
              tab:     s.tab,
              enabled: s.enabled,
              order:   s.order,
              config:  s.config == null ? Prisma.DbNull : (s.config as Prisma.InputJsonValue),
            })),
          },
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
          action:      AuditAction.REGISTER,
          metadata:    { email: normalizedEmail, username: normalizedUsername, invited: invitedFlow },
        },
      });

      // Consume the beta invite single-use, inside the same transaction so the
      // account and the redemption commit together (or not at all). The
      // status: APPROVED guard makes a concurrent second redemption a no-op.
      if (betaRequestId) {
        await tx.betaAccessRequest.updateMany({
          where: { id: betaRequestId, status: BetaAccessRequestStatus.APPROVED },
          data:  {
            status:          BetaAccessRequestStatus.REDEEMED,
            redeemedAt:      new Date(),
            redeemedUserId:  newUser.id,
            inviteTokenHash: null, // single-use — the token can never resolve again
          },
        });
        await tx.auditLog.create({
          data: {
            userId:   newUser.id,
            action:   AuditAction.BETA_ACCESS_REDEEMED,
            metadata: { email: normalizedEmail, betaRequestId },
          },
        });
      }

      return newUser;
    });

    // ── Send the verification email (OPS-1 S2b) ───────────────────────────────
    // After commit so the token is persisted. Absolute link from the trusted
    // env base (never the request Host). Non-throwing: a delivery failure is
    // logged but never fails registration (the account already exists, and the
    // consumer/resend flow is a later slice).
    //
    // SKIPPED for invited signups: the invite email already proved inbox
    // ownership, so the account was created pre-verified (emailVerifiedAt set,
    // no token stored) and there is nothing to verify.
    if (!invitedFlow) {
      const verifyUrl = buildVerifyUrl(env.NEXT_PUBLIC_APP_URL, rawVerificationToken);
      const emailResult = await sendEmail("email-verification", normalizedEmail, { verifyUrl });
      if (emailResult.status === "error") {
        console.error("[register] verification email failed to send:", emailResult.error);
      }
    }

    return NextResponse.json({ success: true, userId: user.id }, { status: 201 });
  } catch (err) {
    console.error("[register] error:", err);
    return NextResponse.json({ error: "Registration failed. Please try again." }, { status: 500 });
  }
}
