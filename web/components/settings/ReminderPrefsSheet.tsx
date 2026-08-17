"use client";

import { BottomSheet, Button, Callout, Chip } from "@/components/ui";
import { Toggle } from "@/components/ui/Toggle";

export type ReminderTiming = "3d" | "2d" | "wed-eve" | "day-before";

export interface ReminderPrefs {
  deadlineReminders: boolean;
  lmsReminders: boolean;
  timing: ReminderTiming;
  emailEnabled: boolean;
}

const TIMING_OPTS: { value: ReminderTiming; label: string }[] = [
  { value: "3d", label: "3 days before" },
  { value: "2d", label: "2 days before" },
  { value: "wed-eve", label: "Wed evening" },
  { value: "day-before", label: "Day before" },
];

interface ContentProps {
  prefs: ReminderPrefs;
  onChange: (prefs: ReminderPrefs) => void;
  onSave: () => void;
}

/** Shared content rendered inside the BottomSheet (mobile) or inline card (desktop). */
export function ReminderPrefsContent({ prefs, onChange, onSave }: ContentProps) {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Lead time
        </p>
        <div className="flex flex-wrap gap-2">
          {TIMING_OPTS.map((opt) => (
            <Chip
              key={opt.value}
              selected={prefs.timing === opt.value}
              onClick={() => onChange({ ...prefs, timing: opt.value })}
            >
              {opt.label}
            </Chip>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Channel
        </p>
        <label className="flex cursor-pointer items-center justify-between rounded-lg bg-surface-2 px-4 py-3">
          <span className="text-sm text-primary">Email</span>
          <Toggle
            checked={prefs.emailEnabled}
            onChange={(v) => onChange({ ...prefs, emailEnabled: v })}
            aria-label="Enable email reminders"
          />
        </label>
      </div>

      <Callout tone="info" title="LMS reminders">
        LMS deadlines are set ad-hoc by the organiser. The LMS reminder fires
        early in the qualifying GW to give you time to pick.
      </Callout>

      <Button fullWidth onClick={onSave}>
        Save
      </Button>
    </div>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  prefs: ReminderPrefs;
  onChange: (prefs: ReminderPrefs) => void;
}

export function ReminderPrefsSheet({ open, onClose, prefs, onChange }: SheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Reminder preferences">
      <ReminderPrefsContent prefs={prefs} onChange={onChange} onSave={onClose} />
    </BottomSheet>
  );
}
