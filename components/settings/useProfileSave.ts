"use client";

/**
 * components/settings/useProfileSave.ts
 *
 * Shared client helper for Settings pages that PATCH /api/user/profile
 * (Account + Preferences). Extracted verbatim from the former
 * SettingsClient.saveField so the profile-save wiring — including the JWT
 * session refresh on username change — lives in exactly one place. API and
 * behavior unchanged.
 */

import { useSession } from "next-auth/react";

export function useProfileSave() {
  const { update: updateSession } = useSession();

  return async function saveField(payload: Record<string, string>): Promise<string | null> {
    const res  = await fetch("/api/user/profile", {
      method:  "PATCH",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return data.error ?? "Failed to save.";

    // Propagate username change into the JWT so the sidebar updates immediately.
    if (payload.username !== undefined) {
      await updateSession({ username: payload.username });
    }
    return null;
  };
}
