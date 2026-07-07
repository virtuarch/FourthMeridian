import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { User, ShieldCheck, SlidersHorizontal, Database, ChevronRight, Archive } from "lucide-react";
import { DataCard } from "@/components/atlas/DataCard";

// Settings directory — the permanent entry point for Settings (UX-1). Each
// card navigates to its section. Notifications arrives with OPS-3; no
// placeholder route is created here.
const SECTIONS = [
  { href: "/dashboard/settings/account",     icon: User,              title: "Account",        desc: "Manage your personal information." },
  { href: "/dashboard/settings/security",    icon: ShieldCheck,       title: "Security",       desc: "Password, email, sessions, security history." },
  { href: "/dashboard/settings/preferences", icon: SlidersHorizontal, title: "Preferences",    desc: "Reporting currency and personal defaults." },
  { href: "/dashboard/settings/data",        icon: Database,          title: "Data & Privacy", desc: "Export, archive, privacy tools." },
] as const;

export default async function SettingsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="max-w-2xl mx-auto space-y-6 px-4 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-primary)" }}>Settings</h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Manage your Fourth Meridian account.</p>
        </div>
        <Link
          href="/dashboard/settings/archived-assets"
          aria-label="Archive & Trash"
          title="Archive & Trash"
          className="mt-1 shrink-0 w-9 h-9 rounded-lg flex items-center justify-center border hover:bg-[var(--surface-hover)] transition-colors"
          style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)", color: "var(--text-secondary)" }}
        >
          <Archive size={16} />
        </Link>
      </div>

      <DataCard>
        <div className="space-y-2">
          {SECTIONS.map(({ href, icon: Icon, title, desc }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center justify-between px-4 py-3 rounded-xl border hover:bg-[var(--surface-hover)] transition-colors"
              style={{ background: "var(--surface-inset)", borderColor: "var(--border-hairline)" }}
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "var(--surface-hover-strong)" }}>
                  <Icon size={15} style={{ color: "var(--text-secondary)" }} />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{title}</p>
                  <p className="text-xs" style={{ color: "var(--text-muted)" }}>{desc}</p>
                </div>
              </div>
              <ChevronRight size={15} style={{ color: "var(--text-faint)" }} />
            </Link>
          ))}
        </div>
      </DataCard>
    </div>
  );
}
