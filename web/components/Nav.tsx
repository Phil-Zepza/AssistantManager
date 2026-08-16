"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Squad", icon: "⚽" },
  { href: "/lms", label: "LMS", icon: "🎯" },
  { href: "/history", label: "History", icon: "📊" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
];

export default function Nav() {
  const pathname = usePathname();

  // No nav on auth screens.
  if (pathname === "/login" || pathname.startsWith("/auth")) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-200 bg-white/95 backdrop-blur sm:static sm:border-t-0 sm:border-b">
      <div className="mx-auto flex max-w-2xl items-stretch justify-around sm:justify-start sm:gap-2 sm:px-4">
        {TABS.map((tab) => {
          const active =
            tab.href === "/"
              ? pathname === "/"
              : pathname.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-xs font-medium sm:flex-none sm:flex-row sm:gap-2 sm:px-3 sm:py-3 sm:text-sm ${
                active
                  ? "text-brand"
                  : "text-gray-500 hover:text-gray-800"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span className="text-lg sm:text-base" aria-hidden>
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
