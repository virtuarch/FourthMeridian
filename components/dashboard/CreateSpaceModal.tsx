"use client";

/**
 * CreateSpaceModal
 *
 * Glass modal version of the Create Space form, extended into a short
 * optional onboarding flow:
 *
 *   1. Create Space   — original form (name, type, description, privacy).
 *      Unchanged validation + POST /api/spaces. On success the modal no
 *      longer closes — it advances to step 2 with the newly-created Space.
 *   2. Add Accounts   — optional. Reuses existing entry points verbatim:
 *      "Add existing accounts" renders ShareExistingAccountsPanel — the same
 *      account-sharing component ManageSpaceModal's Finances tab uses
 *      (exported from there for this exact reason) — against the new Space,
 *      so moving an account a user already owns into the new Space is the
 *      same POST /api/spaces/:id/accounts/share call, not a duplicate.
 *      The remaining three options are Plaid via PlaidContext/usePlaid()
 *      (ConnectAccountButton's own logic, inlined here since this step
 *      needs the open/loading state directly rather than a pre-built
 *      button), AddManualAssetModal, and AddWalletModal. No new account or
 *      Plaid APIs were added — these are the same modals/routes used
 *      everywhere else in the app, just triggerable from inside this flow.
 *      Plaid-linked and wallet accounts still land in the Personal Space
 *      (existing behavior, unchanged — neither flow accepts a target
 *      space today); manual assets are the one *new-account* path that
 *      can target a specific Space, so this step pre-checks the new Space
 *      in AddManualAssetModal's sharing picker via the (new, additive,
 *      optional) `defaultSpaceIds` prop. See the "Future enhancement"
 *      note below.
 *   3. Invite Users   — optional. Reuses ManageSpaceModal's own
 *      UserSearchInput component and the exact same
 *      POST /api/spaces/:id/invite route MembersTab already calls —
 *      no new invite API. UserSearchInput/userDisplayName/UserResult are
 *      exported from ManageSpaceModal.tsx specifically so this step
 *      could import the real thing instead of recreating it.
 *   4. Done           — confirms creation; "Open Space" calls the existing
 *      POST /api/space/switch (same call Sidebar.tsx and
 *      SpacesClient.tsx already make) and navigates to /dashboard.
 *
 * Future enhancement (not implemented — would require backend changes):
 * letting Plaid Link and the wallet-add flow accept a target spaceId at
 * connect time, the way manual assets already can, so accounts added here
 * land directly in the new Space instead of Personal-by-default. Today the
 * user can still move them in via Manage → Finances → "Share into Space",
 * which already exists.
 *
 * Open/close is driven by a tiny window CustomEvent ("open-create-space"),
 * the same decoupled-listener pattern this codebase already uses for
 * "space-list-changed" / "space-invites-changed" (see Sidebar.tsx,
 * SpacesClient.tsx) — any trigger just dispatches the event; it doesn't
 * need a reference to this component or to whoever currently mounts it.
 * DashboardChrome.tsx owns the single mounted instance + open state, since
 * it's the actual common ancestor of the Sidebar and every page (including
 * the Spaces page).
 *
 * Step 1's form fields, validation, and the POST /api/spaces submit
 * logic are unchanged from the old CreateSpacePanel — only the chrome
 * around them and the post-success behavior (advance instead of close)
 * are new. As of the Atlas Glass Modal Doctrine Phase 3 (migration 3.2)
 * that chrome is the shared FormModal → OverlaySurface primitive (portal,
 * focus-trap, body-scroll-lock, panel height cap, named z-scale), which
 * retires this file's hand-rolled recipe R3 shell; Escape/backdrop
 * dismissal now comes from the primitive (see the `isBusy` / preventClose
 * note below). The "space-list-changed" dispatch on success is preserved
 * verbatim so the Sidebar's Spaces list keeps refreshing as it always has.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Globe, Lock, Loader2, Plus, X, ArrowLeft,
  Landmark, Package, Wallet, FolderInput, Mail, ArrowRight, CheckCircle2,
} from "lucide-react";
import { FormModal } from "@/components/atlas/FormModal";
import { GlassButton } from "@/components/atlas/GlassButton";
import { displaySpaceName } from "@/lib/format";
import { usePlaid } from "@/context/PlaidContext";
import {
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  PRIMARY_CATEGORIES,
  SECONDARY_CATEGORIES,
  SpaceCategory,
} from "@/lib/space-presets";
import { CategoryIcon } from "@/components/dashboard/SpacesClient";
import { AddManualAssetModal } from "@/components/dashboard/AddManualAssetModal";
import { AddWalletModal } from "@/components/dashboard/AddWalletModal";
import {
  UserSearchInput, userDisplayName, type UserResult,
  ShareExistingAccountsPanel,
} from "@/components/dashboard/ManageSpaceModal";
import {
  SPACE_LIST_CHANGED_EVENT,
  SPACE_ACCOUNTS_CHANGED_EVENT,
  SPACE_INVITES_CHANGED_EVENT,
} from "@/lib/space-nav";

// Shared selected/unselected tint for this modal's option-chip grids (Space
// Type + Privacy) — moved verbatim from the old CreateSpacePanel, which is
// the only place it was ever used.
function chipTone(selected: boolean): string {
  return selected
    ? "border-[rgba(125,168,255,.4)] bg-[rgba(59,130,246,.10)]"
    : "border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)]";
}

type Step = "create" | "accounts" | "invite" | "done";

const STEP_ORDER: Step[] = ["create", "accounts", "invite", "done"];
const STEP_LABELS: Record<Step, string> = {
  create:   "Create Space",
  accounts: "Add Accounts",
  invite:   "Invite Users",
  done:     "Done",
};

function StepIndicator({ current }: { current: Step }) {
  const idx = STEP_ORDER.indexOf(current);
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1.5">
        {STEP_ORDER.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              i <= idx ? "bg-[var(--meridian-400)]" : "bg-[var(--border-hairline)]"
            }`}
          />
        ))}
      </div>
      <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
        Step {idx + 1} of {STEP_ORDER.length} — {STEP_LABELS[current]}
      </p>
    </div>
  );
}

function AccountOptionRow({
  icon, label, sublabel, onClick, disabled,
}: {
  icon:      React.ReactNode;
  label:     string;
  sublabel?: string;
  onClick:   () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 px-3.5 py-3 rounded-[var(--radius-md)] border border-[var(--border-hairline)] hover:border-[var(--border-hairline-strong)] hover:bg-[var(--surface-hover)] transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <div className="w-9 h-9 rounded-[var(--radius-sm)] bg-[var(--surface-muted)] flex items-center justify-center shrink-0 text-[var(--text-secondary)]">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{label}</p>
        {sublabel && <p className="text-xs text-[var(--text-muted)] mt-0.5">{sublabel}</p>}
      </div>
      <ArrowRight size={14} className="text-[var(--text-muted)] shrink-0" />
    </button>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after a successful create, in addition to closing. */
  onCreated?: () => void;
}

export function CreateSpaceModal({ open, onClose, onCreated }: Props) {
  const router = useRouter();

  // ── Step 1: Create ──────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>("create");
  const [newSpace, setNewSpace] = useState<{ id: string; name: string } | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [category, setCategory] = useState<SpaceCategory | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ── Step 2: Add Accounts ────────────────────────────────────────────────
  const [accountsAdded, setAccountsAdded] = useState(0);
  const [nestedModal, setNestedModal] = useState<"existing" | "manual" | "wallet" | null>(null);
  const { openLink: openPlaidLink, isLoading: plaidLoading, isOpen: plaidOpen, error: plaidError } = usePlaid();

  // ── Step 3: Invite Users ────────────────────────────────────────────────
  const [inviteSelectedUser, setInviteSelectedUser] = useState<UserResult | null>(null);
  const [inviteRole, setInviteRole] = useState("MEMBER");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [invitesSent, setInvitesSent] = useState<UserResult[]>([]);

  // ── Step 4: Done ─────────────────────────────────────────────────────────
  const [switching, setSwitching] = useState(false);

  const isBusy = busy || inviteBusy || switching || plaidLoading || plaidOpen || nestedModal !== null;

  // Escape / backdrop dismissal is owned by the FormModal primitive, blocked
  // whenever `isBusy` is true (via preventClose below). Because `isBusy`
  // includes `nestedModal !== null`, pressing Escape with a nested account
  // modal open closes that nested modal (its own OverlaySurface handler) and
  // leaves this flow intact — exactly what the previous hand-rolled handler
  // did, now without a bespoke keydown listener.
  if (!open) return null;

  const visibleCategories = showAll ? [...PRIMARY_CATEGORIES, ...SECONDARY_CATEGORIES] : PRIMARY_CATEGORIES;

  function resetForm() {
    setName("");
    setDescription("");
    setIsPublic(false);
    setCategory(null);
    setShowAll(false);
    setError("");
    setStep("create");
    setNewSpace(null);
    setAccountsAdded(0);
    setNestedModal(null);
    setInviteSelectedUser(null);
    setInviteRole("MEMBER");
    setInviteError("");
    setInvitesSent([]);
  }

  function handleClose() {
    if (isBusy) return;
    resetForm();
    onClose();
  }

  // ── Step 1 submit ────────────────────────────────────────────────────────
  async function handleCreate() {
    if (!name.trim()) { setError("Name is required"); return; }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:        name.trim(),
          description: description.trim() || undefined,
          isPublic,
          category:    category ?? SpaceCategory.OTHER,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setError(d.error ?? "Failed to create");
        return;
      }
      const created = await res.json();
      window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
      setNewSpace({ id: created.id, name: created.name });
      onCreated?.();
      setStep("accounts");
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  // ── Step 2 actions ───────────────────────────────────────────────────────
  function handleConnectBank() {
    openPlaidLink(() => {
      setAccountsAdded((n) => n + 1);
      window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
    });
  }

  function handleNestedAdded() {
    setAccountsAdded((n) => n + 1);
    window.dispatchEvent(new CustomEvent(SPACE_ACCOUNTS_CHANGED_EVENT));
  }

  // ── Step 3 actions ───────────────────────────────────────────────────────
  async function handleSendInvite() {
    if (!inviteSelectedUser || !newSpace) return;
    setInviteBusy(true);
    setInviteError("");
    try {
      const res = await fetch(`/api/spaces/${newSpace.id}/invite`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username: inviteSelectedUser.username ?? inviteSelectedUser.id, role: inviteRole }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError(d.error ?? "Failed to invite");
        return;
      }
      setInvitesSent((prev) => [...prev, inviteSelectedUser]);
      setInviteSelectedUser(null);
      window.dispatchEvent(new CustomEvent(SPACE_INVITES_CHANGED_EVENT));
    } catch {
      setInviteError("Network error");
    } finally {
      setInviteBusy(false);
    }
  }

  // ── Step 4 action ────────────────────────────────────────────────────────
  async function handleOpenSpace() {
    if (!newSpace) return;
    setSwitching(true);
    try {
      const res = await fetch("/api/space/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ spaceId: newSpace.id }),
      });
      if (res.ok) {
        window.dispatchEvent(new CustomEvent(SPACE_LIST_CHANGED_EVENT));
        resetForm();
        onClose();
        // Order matters here. router.push() starts loading the destination
        // route's chunk/RSC payload immediately; calling router.refresh()
        // right after it (the previous order) invalidates the router cache
        // while that fetch is still in flight and was racing it — the
        // intermittent "ChunkLoadError: Loading chunk
        // app/(shell)/dashboard/page failed" came from that race, not from a
        // stale chunk or naming issue. Sidebar.tsx's handleSwitch already
        // does this same space-switch + navigate sequence without the
        // bug, and it calls refresh() *before* push() — settle the cache
        // invalidation first, then start a clean navigation. Matching that
        // proven order here (rather than inventing a new pattern) fixes it.
        router.refresh();
        router.push("/dashboard");
      }
    } finally {
      setSwitching(false);
    }
  }

  // ─── Step bodies ────────────────────────────────────────────────────────

  const stepCreate = (
    <div className="flex flex-col gap-7">
      <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
        A new Space for a family, business, property, or anything else you want to track separately.
      </p>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-3 block">Space Type</label>
        <div className="grid grid-cols-2 gap-2.5">
          {visibleCategories.map((cat) => {
            const selected = category === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(selected ? null : cat)}
                className={[
                  "flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-sm)] border text-left transition-[transform,background-color,border-color] active:scale-[0.97]",
                  chipTone(selected),
                ].join(" ")}
              >
                <span className={selected ? "text-[var(--meridian-400)]" : "text-[var(--text-muted)]"}>
                  <CategoryIcon name={CATEGORY_ICONS[cat]} />
                </span>
                <span className={`text-xs truncate ${selected ? "text-[var(--text-primary)] font-medium" : "text-[var(--text-secondary)]"}`}>
                  {CATEGORY_LABELS[cat]}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setShowAll((p) => !p)}
          className="w-full text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] mt-2 py-1.5 transition-colors"
        >
          {showAll ? "Show fewer types" : "Show more types →"}
        </button>
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">Space Name</label>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setError(""); }}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="e.g. Smith Family, Atlanta Duplex"
          maxLength={60}
          className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-1.5 block">
          Description <span className="text-[var(--text-muted)]">(optional)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this Space for?"
          rows={2}
          maxLength={200}
          className="w-full rounded-[var(--radius-sm)] px-3 py-2.5 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none transition-colors resize-none"
          style={{ background: "var(--surface-muted)", border: "1px solid var(--border-hairline)" }}
        />
      </div>

      <div>
        <label className="text-xs font-medium text-[var(--text-secondary)] mb-3 block">Privacy</label>
        <div className="grid grid-cols-2 gap-2.5">
          {[false, true].map((pub) => {
            const selected = isPublic === pub;
            return (
              <button
                key={String(pub)}
                type="button"
                onClick={() => setIsPublic(pub)}
                className={[
                  "flex items-center justify-center gap-2 px-3 py-2.5 rounded-[var(--radius-sm)] border transition-[transform,background-color,border-color] active:scale-[0.97]",
                  chipTone(selected),
                ].join(" ")}
              >
                {pub ? <Globe size={13} /> : <Lock size={13} />}
                <span className="text-xs text-[var(--text-secondary)]">{pub ? "Public" : "Private"}</span>
              </button>
            );
          })}
        </div>
      </div>

      {error && <p className="text-xs text-[var(--coral-400)]">{error}</p>}

      <GlassButton
        onClick={handleCreate}
        disabled={busy || !name.trim()}
        tone="meridian"
        fullWidth
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
        Create Space
      </GlassButton>
    </div>
  );

  const stepAccounts = (
    <div className="flex flex-col gap-5">
      {nestedModal === "existing" ? (
        <>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNestedModal(null)}
              className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)] transition-colors"
              aria-label="Back"
            >
              <ArrowLeft size={15} />
            </button>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Add existing accounts</h3>
          </div>
          {newSpace && (
            <ShareExistingAccountsPanel spaceId={newSpace.id} onShared={handleNestedAdded} />
          )}
        </>
      ) : (
        <>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Add Accounts</h3>
            <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
              Bring accounts into {displaySpaceName(newSpace?.name) || "this Space"} now, or skip and add them anytime from Manage.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <AccountOptionRow
              icon={<FolderInput size={16} />}
              label="Add existing accounts"
              sublabel="Move or share accounts already in your profile"
              onClick={() => setNestedModal("existing")}
            />
            <AccountOptionRow
              icon={<Landmark size={16} />}
              label="Connect bank account"
              sublabel="Securely link via Plaid"
              onClick={handleConnectBank}
              disabled={plaidLoading || plaidOpen}
            />
            <AccountOptionRow
              icon={<Package size={16} />}
              label="Add manual asset"
              sublabel="Property, vehicle, equipment, and more"
              onClick={() => setNestedModal("manual")}
            />
            <AccountOptionRow
              icon={<Wallet size={16} />}
              label="Add wallet"
              sublabel="Track a crypto wallet by address"
              onClick={() => setNestedModal("wallet")}
            />
          </div>

          {plaidError && <p className="text-xs text-[var(--coral-400)]">{plaidError}</p>}

          {accountsAdded > 0 && (
            <p className="text-xs text-[var(--emerald-400)] flex items-center gap-1.5">
              <CheckCircle2 size={13} />
              {accountsAdded} account{accountsAdded > 1 ? "s" : ""} added
            </p>
          )}
        </>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={() => setStep("invite")}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          Skip for now
        </button>
        {accountsAdded > 0 && (
          <GlassButton onClick={() => setStep("invite")} tone="meridian" size="sm">
            Continue
            <ArrowRight size={13} />
          </GlassButton>
        )}
      </div>
    </div>
  );

  const stepInvite = (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Invite Users</h3>
        <p className="text-xs text-[var(--text-muted)] mt-1 leading-relaxed">
          Invite people to {displaySpaceName(newSpace?.name) || "this Space"}, or skip and invite them anytime from Manage → Members.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {inviteSelectedUser ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-[var(--surface-muted)] border border-[rgba(125,168,255,.3)]">
              <div className="w-6 h-6 rounded-full bg-[rgba(59,130,246,.20)] flex items-center justify-center shrink-0">
                <span className="text-[10px] font-semibold text-[var(--meridian-400)]">
                  {userDisplayName(inviteSelectedUser)[0].toUpperCase()}
                </span>
              </div>
              <p className="text-sm text-[var(--text-primary)] flex-1 truncate">{userDisplayName(inviteSelectedUser)}</p>
              <button
                onClick={() => { setInviteSelectedUser(null); setInviteError(""); }}
                className="p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                <X size={13} />
              </button>
            </div>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
              className="bg-[var(--surface-muted)] border border-[var(--border-hairline)] rounded-xl text-xs text-[var(--text-secondary)] px-2 py-2.5 focus:outline-none"
            >
              <option value="ADMIN">Admin</option>
              <option value="MEMBER">Member</option>
              <option value="VIEWER">Viewer</option>
            </select>
            <GlassButton onClick={handleSendInvite} disabled={inviteBusy} tone="meridian" size="sm">
              {inviteBusy ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
              Send
            </GlassButton>
          </div>
        ) : newSpace ? (
          <UserSearchInput
            spaceId={newSpace.id}
            onSelect={(u) => { setInviteSelectedUser(u); setInviteError(""); }}
          />
        ) : null}
        {inviteError && <p className="text-xs text-[var(--coral-400)]">{inviteError}</p>}
      </div>

      {invitesSent.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-widest">Invited</p>
          {invitesSent.map((u, i) => (
            <p key={`${u.id}-${i}`} className="text-xs text-[var(--emerald-400)] flex items-center gap-1.5">
              <CheckCircle2 size={13} />
              {userDisplayName(u)}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={() => setStep("done")}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
        >
          Skip for now
        </button>
        {invitesSent.length > 0 && (
          <GlassButton onClick={() => setStep("done")} tone="meridian" size="sm">
            Continue
            <ArrowRight size={13} />
          </GlassButton>
        )}
      </div>
    </div>
  );

  const stepDone = (
    <div className="flex flex-col gap-6 text-center py-2">
      <div className="flex flex-col items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-[rgba(16,185,129,.12)] flex items-center justify-center">
          <CheckCircle2 size={24} className="text-[var(--emerald-400)]" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-[var(--text-primary)]">
            {displaySpaceName(newSpace?.name) || "Your Space"} is ready
          </h3>
          <p className="text-xs text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-xs mx-auto">
            You can add accounts, invite people, or change settings anytime from Manage.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <GlassButton onClick={handleOpenSpace} disabled={switching} tone="meridian" fullWidth>
          {switching ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          Open Space
        </GlassButton>
        <GlassButton onClick={handleClose} tone="neutral" fullWidth>
          Close
        </GlassButton>
      </div>
    </div>
  );

  const stepBody = step === "create" ? stepCreate
    : step === "accounts" ? stepAccounts
    : step === "invite" ? stepInvite
    : stepDone;

  return (
    <>
      <FormModal
        open
        onClose={handleClose}
        title="Create Space"
        size="md"
        preventClose={isBusy}
        toolbar={<StepIndicator current={step} />}
      >
        {stepBody}
      </FormModal>

      {nestedModal === "manual" && (
        <AddManualAssetModal
          onClose={() => setNestedModal(null)}
          onAdd={handleNestedAdded}
          defaultSpaceIds={newSpace ? [newSpace.id] : undefined}
          zIndex={300}
        />
      )}
      {nestedModal === "wallet" && (
        <AddWalletModal
          onClose={() => setNestedModal(null)}
          onAdd={handleNestedAdded}
          zIndex={300}
        />
      )}
    </>
  );
}
