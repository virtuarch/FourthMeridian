"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  Brain,
} from "lucide-react";

const nav = [
  { label: "Dashboard",  href: "/dashboard",            icon: LayoutDashboard },
  { label: "Workspaces", href: "/dashboard/workplaces", icon: Building2 },
  { label: "AI",         href: "/dashboard/analyze",    icon: Brain },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-50 border-t border-gray-800 bg-gray-950/95 backdrop-blur-sm">
      <div className="flex items-center justify-around h-16">
        {nav.map(({ label, href, icon: Icon }) => {
          const active =
            href === "/dashboard"
              ? path === "/dashboard"
              : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={`flex flex-col items-center gap-1 px-3 py-2 rounded-xl transition-colors ${
                active ? "text-blue-400" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              <Icon size={20} strokeWidth={active ? 2.5 : 1.5} />
              <span className="text-xs font-medium">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
