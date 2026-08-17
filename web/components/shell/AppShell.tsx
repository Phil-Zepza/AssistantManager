"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  History as HistoryIcon,
  Home,
  LogOut,
  Settings,
  Target,
  Users,
} from "lucide-react";
import { Badge, Countdown } from "@/components/ui";
import { signOutAction } from "@/app/actions";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Home;
  /** Active when the pathname starts with this (falls back to href). */
  match?: string;
  exact?: boolean;
}

// Same routes as before — Settings is intentionally NOT in the dock (it lives in
// the avatar popover / rail footer).
const NAV: NavItem[] = [
  { href: "/", label: "Home", icon: Home, exact: true },
  { href: "/squad/edit", label: "Squad", icon: Users, match: "/squad" },
  { href: "/lms", label: "LMS", icon: Target, match: "/lms" },
  { href: "/history", label: "History", icon: HistoryIcon, match: "/history" },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname.startsWith(item.match ?? item.href);
}

function contextualTitle(pathname: string): string {
  if (pathname === "/") return "Home";
  if (pathname.startsWith("/squad")) return "Squad";
  if (pathname.startsWith("/lms")) return "LMS";
  if (pathname.startsWith("/history")) return "History";
  if (pathname.startsWith("/settings")) return "Settings";
  return "FPL / LMS";
}

export interface AppShellProps {
  children: ReactNode;
  userEmail?: string | null;
  gw?: number | null;
  deadline?: string | null;
}

export function AppShell({ children, userEmail, gw, deadline }: AppShellProps) {
  const pathname = usePathname();
  const title = contextualTitle(pathname);

  return (
    <div className="min-h-screen">
      {/* Desktop left rail */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-subtle bg-raised md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-sm font-black text-on-accent">
            P
          </span>
          <span className="leading-tight">
            <span className="block text-sm font-extrabold tracking-tight text-primary">
              PUSB
            </span>
            <span className="block text-[11px] font-medium text-muted">
              FPL + LMS
            </span>
          </span>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV.map((item) => (
            <RailLink
              key={item.href}
              item={item}
              active={isActive(pathname, item)}
            />
          ))}
        </nav>

        <div className="space-y-1 border-t border-subtle p-3">
          <Link
            href="/settings"
            className={cn(
              "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-micro ease-out-soft",
              pathname.startsWith("/settings")
                ? "bg-surface text-primary"
                : "text-secondary hover:bg-surface hover:text-primary",
            )}
          >
            {pathname.startsWith("/settings") && (
              <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
            )}
            <Settings className="h-[18px] w-[18px]" />
            Settings
          </Link>
          <AvatarMenu email={userEmail} placement="up" />
        </div>
      </aside>

      {/* Main column */}
      <div className="md:pl-[232px]">
        <header className="sticky top-0 z-20 border-b border-subtle bg-base/80 backdrop-blur supports-[backdrop-filter]:bg-base/70 pt-[env(safe-area-inset-top)]">
          <div className="flex h-14 items-center gap-3 px-4">
            <h1 className="truncate text-base font-semibold text-primary">
              {title}
            </h1>
            <div className="ml-auto flex items-center gap-2.5">
              {gw != null && <Badge tone="accent">GW {gw}</Badge>}
              <Countdown deadline={deadline} className="text-sm" />
              <div className="md:hidden">
                <AvatarMenu email={userEmail} placement="down" />
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1100px] px-4 pb-24 pt-4 md:pb-10">
          {children}
        </main>
      </div>

      {/* Mobile bottom dock */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-subtle bg-raised/95 shadow-dock backdrop-blur md:hidden">
        <div className="mx-auto flex max-w-lg items-stretch justify-around pb-[env(safe-area-inset-bottom)]">
          {NAV.map((item) => (
            <DockLink
              key={item.href}
              item={item}
              active={isActive(pathname, item)}
            />
          ))}
        </div>
      </nav>
    </div>
  );
}

function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-micro ease-out-soft",
        active
          ? "bg-surface text-primary"
          : "text-secondary hover:bg-surface hover:text-primary",
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-accent" />
      )}
      <Icon className={cn("h-[18px] w-[18px]", active && "text-accent")} />
      {item.label}
    </Link>
  );
}

function DockLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className="relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium"
    >
      {active && (
        <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-accent" />
      )}
      <Icon
        className={cn("h-5 w-5", active ? "text-accent" : "text-muted")}
        aria-hidden
      />
      <span className={active ? "text-accent" : "text-muted"}>
        {item.label}
      </span>
    </Link>
  );
}

function AvatarMenu({
  email,
  placement,
}: {
  email?: string | null;
  placement: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = email?.trim()?.[0]?.toUpperCase() ?? "U";

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className={cn("relative", placement === "up" && "flex justify-start")}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-sm font-semibold text-primary ring-1 ring-subtle transition-colors hover:ring-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {initial}
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute right-0 z-40 w-52 overflow-hidden rounded-lg border border-subtle bg-surface-2 p-1 shadow-sheet",
            placement === "down" ? "top-full mt-2" : "bottom-full mb-2 left-0",
          )}
        >
          {email && (
            <p className="truncate px-3 py-2 text-xs text-muted" title={email}>
              {email}
            </p>
          )}
          <Link
            role="menuitem"
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface hover:text-primary"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          <form action={signOutAction}>
            <button
              role="menuitem"
              type="submit"
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-secondary transition-colors hover:bg-surface hover:text-primary"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
