"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useEffect, useState, useRef, useCallback } from "react";
import {
  LayoutDashboard,
  Building2,
  Brain,
  RefreshCw,
  LogOut,
  Pencil,
  ChevronDown,
  Crown,
  Shield,
  Users,
  Eye,
  Check,
  Loader2,
} from "lucide-react";

const nav = [
  { label: "Dashboard",       href: "/dashboard",            icon: LayoutDashboard },
  { label: "Workspaces",      href: "/dashboard/workspaces", icon: Building2 },
  { label: "Analyze with AI", href: "/dashboard/analyze",    icon: Brain },
];

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceItem = {
  id:      string;
  name:    string;
  type:    string;
  myRole?: string | null;
};

const ROLE_ICONS: Record<string, React.ReactNode> = {
  OWNER:  <Crown  size={10} className="text-yellow-400" />,
  ADMIN:  <Shield size={10} className="text-blue-400"   />,
  MEMBER: <Users  size={10} className="text-gray-400"   />,
  VIEWER: <Eye    size={10} className="text-gray-500"   />,
};

const COOKIE_NAME = "fintracker_workspace";

function readWorkspaceCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ── Workspace Switcher ────────────────────────────────────────────────────────

function WorkspaceSwitcher() {
  const router = useRouter();
  const [open,         setOpen]         = useState(false);
  const [workspaces,   setWorkspaces]   = useState<WorkspaceItem[]>([]);
  const [activeId,     setActiveId]     = useState<string | null>(null);
  const [switching,    setSwitching]    = useState<string | null>(null);
  const [loaded,       setLoaded]       = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces");
      if (!res.ok) return;
      const data = await res.json();

      // mine includes PERSONAL + SHARED workspaces with myRole
      const mine: WorkspaceItem[] = (data.mine ?? []).map((w: WorkspaceItem & { members?: unknown[] }) => ({
        id:     w.id,
        name:   w.name,
        type:   w.type,
        myRole: w.myRole,
      }));

      setWorkspaces(mine);

      // Determine active workspace from cookie
      const cookieId = readWorkspaceCookie();
      if (cookieId && mine.some((w) => w.id === cookieId)) {
        setActiveId(cookieId);
      } else {
        // Default to personal
        const personal = mine.find((w) => w.type === "PERSONAL");
        if (personal) setActiveId(personal.id);
      }
      setLoaded(true);
    } catch {
      // Non-fatal — UI falls back gracefully
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  // Reload whenever the dropdown opens (catches newly created workspaces)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) loadWorkspaces();
  }, [open, loadWorkspaces]);

  // Listen for workspace-list-changed events dispatched after creation/deletion
  useEffect(() => {
    function handleChange() { loadWorkspaces(); }
    window.addEventListener("workspace-list-changed", handleChange);
    return () => window.removeEventListener("workspace-list-changed", handleChange);
  }, [loadWorkspaces]);

  async function handleSwitch(workspaceId: string) {
    if (workspaceId === activeId) { setOpen(false); return; }
    setSwitching(workspaceId);
    try {
      const res = await fetch("/api/workspace/switch", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ workspaceId }),
      });
      if (res.ok) {
        setActiveId(workspaceId);
        setOpen(false);
        router.refresh(); // re-run server components with new cookie
        // Navigate to dashboard to show the new workspace context
        router.push("/dashboard");
      }
    } finally {
      setSwitching(null);
    }
  }

  const activeWs = workspaces.find((w) => w.id === activeId);
  const isPersonal = activeWs?.type === "PERSONAL";

  if (!loaded) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 mx-2 rounded-xl bg-gray-800/60">
        <div className="w-6 h-6 rounded-lg bg-gray-700 shrink-0" />
        <div className="flex-1 h-3 bg-gray-700 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div ref={ref} className="relative mx-2">
      <button
        onClick={() => setOpen((p) => !p)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-colors text-left ${
          open ? "bg-gray-700" : "bg-gray-800/60 hover:bg-gray-800"
        }`}
      >
        <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
          isPersonal ? "bg-blue-600/30" : "bg-gray-600"
        }`}>
          <Building2 size={12} className={isPersonal ? "text-blue-400" : "text-gray-400"} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-white truncate">
            {activeWs?.name ?? "Loading…"}
          </p>
          <p className="text-[10px] text-gray-500">
            {isPersonal ? "Personal" : "Shared workspace"}
          </p>
        </div>
        <ChevronDown size={13} className={`text-gray-500 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="px-3 pt-2.5 pb-1">
            <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest">
              Switch Workspace
            </p>
          </div>
          {workspaces.map((ws) => {
            const isActive  = ws.id === activeId;
            const personal  = ws.type === "PERSONAL";
            const isBusy    = switching === ws.id;
            return (
              <button
                key={ws.id}
                onClick={() => handleSwitch(ws.id)}
                disabled={!!switching}
                className={`w-full flex items-center gap-2.5 px-3 py-2 transition-colors disabled:opacity-50 ${
                  isActive ? "bg-blue-600/15" : "hover:bg-gray-700/60"
                }`}
              >
                <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 ${
                  personal ? "bg-blue-600/25" : "bg-gray-600/60"
                }`}>
                  {isBusy
                    ? <Loader2 size={11} className="animate-spin text-gray-400" />
                    : <Building2 size={11} className={personal ? "text-blue-400" : "text-gray-400"} />
                  }
                </div>
                <div className="flex-1 min-w-0 text-left">
                  <p className="text-xs text-white truncate">{ws.name}</p>
                  {ws.myRole && (
                    <span className="flex items-center gap-0.5 text-[10px] text-gray-500">
                      {ROLE_ICONS[ws.myRole] ?? null}
                      <span className="ml-0.5">{ws.myRole.charAt(0) + ws.myRole.slice(1).toLowerCase()}</span>
                    </span>
                  )}
                </div>
                {isActive && <Check size={13} className="text-blue-400 shrink-0" />}
              </button>
            );
          })}
          <div className="px-3 py-2 border-t border-gray-700/60">
            <Link
              href="/dashboard/workspaces"
              onClick={() => setOpen(false)}
              className="block text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              Manage workspaces →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export function Sidebar() {
  const path              = usePathname();
  const { data: session } = useSession();
  const [pendingInvites, setPendingInvites] = useState(0);

  // Fetch pending invite count
  const loadPendingInvites = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces/invites/pending");
      if (!res.ok) return;
      const data = await res.json();
      setPendingInvites(data.count ?? 0);
    } catch {
      // non-fatal
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadPendingInvites(); }, [loadPendingInvites]);

  // Re-fetch when invites change (accept/decline/new invite)
  useEffect(() => {
    function handle() { loadPendingInvites(); }
    window.addEventListener("workspace-invites-changed", handle);
    window.addEventListener("workspace-list-changed",   handle);
    return () => {
      window.removeEventListener("workspace-invites-changed", handle);
      window.removeEventListener("workspace-list-changed",   handle);
    };
  }, [loadPendingInvites]);

  const user     = session?.user;
  const initial  = (user?.name ?? user?.email ?? "?")[0].toUpperCase();
  const username = user?.username ? `@${user.username}` : null;

  return (
    <aside className="hidden lg:flex flex-col w-60 shrink-0 border-r border-gray-800 bg-gray-950 min-h-screen sticky top-0">
      {/* Logo */}
      <div className="flex items-center gap-1.5 px-5 h-14 border-b border-gray-800">
        <img src="/logo-icon.png" alt="FinTracker" className="w-8 h-8 rounded-xl shrink-0 object-contain" />
        <span className="font-bold text-white text-lg">FinTracker</span>
      </div>

      {/* Workspace switcher */}
      <div className="py-2 border-b border-gray-800">
        <WorkspaceSwitcher />
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ label, href, icon: Icon }) => {
          const active =
            href === "/dashboard"
              ? path === "/dashboard"
              : path.startsWith(href);
          const badge = label === "Workspaces" && pendingInvites > 0 ? pendingInvites : null;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-gray-400 hover:text-white hover:bg-gray-800"
              }`}
            >
              <Icon size={18} strokeWidth={active ? 2.5 : 1.75} />
              <span className="flex-1">{label}</span>
              {badge !== null && (
                <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                  {badge > 9 ? "9+" : badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-5 space-y-1">
        <button className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-gray-400 hover:text-white hover:bg-gray-800 transition-colors">
          <RefreshCw size={18} strokeWidth={1.75} />
          Refresh Data
        </button>

        <button
          onClick={async () => { await signOut({ redirect: false }); window.location.href = "/login"; }}
          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-medium text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors"
        >
          <LogOut size={18} strokeWidth={1.75} />
          Sign Out
        </button>

        {/* User identity */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <div className="w-7 h-7 rounded-full bg-blue-600/20 border border-blue-500/30 flex items-center justify-center shrink-0">
            <span className="text-blue-400 text-xs font-semibold">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-white truncate">{user?.name ?? "—"}</p>
            {username ? (
              <p className="text-xs text-gray-500 truncate">{username}</p>
            ) : (
              <p className="text-xs text-gray-600 truncate">{user?.email}</p>
            )}
          </div>
          <Link
            href="/dashboard/settings"
            className="p-1.5 rounded-lg text-gray-600 hover:text-gray-300 hover:bg-gray-800 transition-colors shrink-0"
            title="Edit profile"
          >
            <Pencil size={12} />
          </Link>
        </div>
      </div>
    </aside>
  );
}
