"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, LogOut, Smartphone } from "lucide-react";
import { Badge, Button, Card, SectionTitle } from "@/components/ui";
import { Toggle } from "@/components/ui/Toggle";
import {
  ReminderPrefsContent,
  ReminderPrefsSheet,
  type ReminderPrefs,
} from "./ReminderPrefsSheet";
import { SignOutSheet } from "./SignOutSheet";
import EditProfileSheet from "@/components/profile/EditProfileSheet";
import { cn } from "@/lib/cn";
import type { User } from "@/lib/types";

const DEFAULT_PREFS: ReminderPrefs = {
  deadlineReminders: false,
  lmsReminders: false,
  timing: "wed-eve",
  emailEnabled: false,
};

const TIMING_LABELS: Record<ReminderPrefs["timing"], string> = {
  "3d": "3 days before",
  "2d": "2 days before",
  "wed-eve": "Wed evening",
  "day-before": "Day before",
};

// Reminder-pref persistence is stubbed — no DB columns or server action exist
// yet. State lives in component memory and resets on page refresh. Wire these up
// once a `reminder_prefs` column (or separate table) + `saveReminderPrefs`
// server action are added in a follow-up migration.
export function SettingsCanvas({ user }: { user: User }) {
  const [editOpen, setEditOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [desktopPanel, setDesktopPanel] = useState<"reminders" | null>(null);
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_PREFS);

  // Detect mobile so we route reminder prefs to a sheet (mobile) vs. inline
  // right panel (desktop). Starts true (mobile-first) and corrects after mount.
  const [isMobile, setIsMobile] = useState(true);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    setIsMobile(!mq.matches);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(!e.matches);
      if (e.matches) setReminderOpen(false); // close sheet if viewport expands
      if (!e.matches) setDesktopPanel(null); // close inline panel if shrinks
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const name = user.display_name?.trim() || user.name?.trim() || "Manager";

  function openReminders() {
    if (isMobile) {
      setReminderOpen(true);
    } else {
      setDesktopPanel("reminders");
    }
  }

  return (
    <div className="md:grid md:grid-cols-[1fr_320px] md:items-start md:gap-8">
      {/* ── Left: settings list ── */}
      <div className="space-y-1">

        {/* Account */}
        <SectionTitle>Account</SectionTitle>
        <Card padding="none">
          <SettingRow
            label="Display name"
            value={name}
            onClick={() => setEditOpen(true)}
          />
          <SettingRow
            label="FPL Team ID"
            value={user.fpl_entry_id != null ? String(user.fpl_entry_id) : "Not linked"}
            valueMuted={user.fpl_entry_id == null}
            onClick={() => setEditOpen(true)}
          />
          <SettingRow
            label="Email"
            value={user.email ?? "—"}
            readOnly
          />
        </Card>

        {/* Reminders */}
        <SectionTitle className="mt-6">Reminders</SectionTitle>
        <Card padding="none">
          <SettingRow
            label="Deadline reminders"
            control={
              <Toggle
                checked={prefs.deadlineReminders}
                onChange={(v) => setPrefs((p) => ({ ...p, deadlineReminders: v }))}
                aria-label="Deadline reminders"
              />
            }
          />
          <SettingRow
            label="Reminder timing"
            value={TIMING_LABELS[prefs.timing]}
            onClick={openReminders}
            disabled={!prefs.deadlineReminders}
          />
          <SettingRow
            label="LMS round reminders"
            control={
              <Toggle
                checked={prefs.lmsReminders}
                onChange={(v) => setPrefs((p) => ({ ...p, lmsReminders: v }))}
                aria-label="LMS round reminders"
              />
            }
          />
        </Card>

        {/* App */}
        <SectionTitle className="mt-6">App</SectionTitle>
        <Card padding="none">
          <SettingRow
            label="Install app"
            value="Add to Home Screen"
            icon={<Smartphone className="h-4 w-4 text-muted" />}
            onClick={() => {
              // The browser owns the PWA install prompt. We surface a hint but
              // can't trigger the native dialog from JS without a prior user
              // gesture captured in beforeinstallprompt (not wired yet).
            }}
          />
          <SettingRow label="Theme" value="Dark" readOnly />
        </Card>

        {/* Sign out — danger ghost */}
        <div className="pb-8 pt-8">
          <Button
            variant="ghost"
            fullWidth
            size="lg"
            icon={<LogOut />}
            onClick={() => setSignOutOpen(true)}
            className="border border-danger/30 text-danger hover:border-danger/60 hover:bg-danger/10 hover:text-danger"
          >
            Sign out
          </Button>
        </div>
      </div>

      {/* ── Right: desktop inline panel ── */}
      {desktopPanel === "reminders" && (
        <div className="hidden md:block">
          <SectionTitle className="mt-0">Reminder preferences</SectionTitle>
          <Card padding="lg">
            <ReminderPrefsContent
              prefs={prefs}
              onChange={setPrefs}
              onSave={() => setDesktopPanel(null)}
            />
          </Card>
        </div>
      )}

      {/* ── Sheets (mobile) ── */}
      <EditProfileSheet
        user={user}
        open={editOpen}
        onClose={() => setEditOpen(false)}
      />

      <ReminderPrefsSheet
        open={reminderOpen}
        prefs={prefs}
        onChange={setPrefs}
        onClose={() => setReminderOpen(false)}
      />

      <SignOutSheet open={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </div>
  );
}

// ── SettingRow ──────────────────────────────────────────────────────────────

interface SettingRowProps {
  label: string;
  value?: string;
  valueMuted?: boolean;
  readOnly?: boolean;
  control?: ReactNode;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}

function SettingRow({
  label,
  value,
  valueMuted,
  readOnly,
  control,
  icon,
  onClick,
  disabled,
}: SettingRowProps) {
  const interactable = !!onClick && !readOnly && !disabled;

  const inner = (
    <div
      className={cn(
        "flex min-h-[52px] items-center justify-between gap-3 px-4 py-3",
        "border-b border-subtle last:border-0",
        interactable &&
          "cursor-pointer transition-colors duration-micro hover:bg-surface-2",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {icon}
        <span className="text-sm font-medium text-primary">{label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {control}
        {!control && value != null && (
          readOnly ? (
            <Badge tone="gray">{value}</Badge>
          ) : (
            <span
              className={cn(
                "text-sm",
                valueMuted ? "text-muted" : "text-secondary",
              )}
            >
              {value}
            </span>
          )
        )}
        {interactable && !control && (
          <ChevronRight className="h-4 w-4 text-muted" />
        )}
      </div>
    </div>
  );

  if (interactable) {
    return (
      <button
        type="button"
        className={cn("w-full text-left", disabled && "pointer-events-none opacity-40")}
        onClick={onClick}
      >
        {inner}
      </button>
    );
  }

  return (
    <div className={cn(disabled && "pointer-events-none opacity-40")}>{inner}</div>
  );
}
