"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Users, Building2, ScrollText } from "lucide-react";

const NAV = [
  { label: "Overview",   href: "/admin",           icon: LayoutDashboard },
  { label: "Users",      href: "/admin/users",      icon: Users           },
  { label: "Workspaces", href: "/admin/workspaces", icon: Building2       },
  { label: "Audit Log",  href: "/admin/audit",      icon: ScrollText      },
];

export function AdminNav({ mobile }: { mobile?: boolean }) {
  const path = usePathname();

  if (mobile) {
    return (
      <>
        {NAV.map(({ label, href, icon: Icon }) => {
          const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors ${
                active ? "text-red-400" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 1.5} />
              <span className="text-xs font-medium">{label}</span>
            </Link>
          );
        })}
      </>
    );
  }

  return (
    <nav className="p-3 space-y-0.5">
      {NAV.map(({ label, href, icon: Icon }) => {
        const active = href === "/admin" ? path === "/admin" : path.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
              active
                ? "bg-red-500/10 text-red-400"
                : "text-gray-400 hover:text-white hover:bg-gray-800/70"
            }`}
          >
            <Icon size={16} strokeWidth={active ? 2.5 : 1.5} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
