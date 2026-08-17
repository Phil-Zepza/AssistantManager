"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { saveProfile } from "@/app/actions";
import { BottomSheet, Button, Callout, Input } from "@/components/ui";
import type { User } from "@/lib/types";

// The "Edit" button on the profile header + the edit subscreen (BottomSheet on
// mobile, centred dialog on desktop). Editable display name + FPL team ID, with
// a live validation helper. Save goes through the `saveProfile` server action,
// which also triggers a squad re-import (a READ from FPL) when the FPL ID
// changes.
export default function EditProfileSheet({ user }: { user: User }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const storedFplId = user.fpl_entry_id != null ? String(user.fpl_entry_id) : "";
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [fplId, setFplId] = useState(storedFplId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedId = fplId.trim();
  const parsedId = parseInt(trimmedId, 10);
  const idValid = trimmedId === "" || (Number.isFinite(parsedId) && parsedId > 0);
  const idChanged = trimmedId !== "" && trimmedId !== storedFplId;

  function reset() {
    setDisplayName(user.display_name ?? "");
    setFplId(storedFplId);
    setError(null);
    setSaving(false);
  }

  function close() {
    reset();
    setOpen(false);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!idValid) {
      setError("FPL team ID must be a positive number.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveProfile({
        displayName: displayName.trim() || null,
        fplEntryId: trimmedId === "" ? null : parsedId,
      });
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not save. Please try again.");
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<Pencil />}
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>

      <BottomSheet open={open} onClose={close} title="Edit profile">
        <form onSubmit={save} className="space-y-4">
          <Input
            label="Display name"
            placeholder="Your name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />

          <Input
            label="FPL team ID"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="e.g. 1234567"
            value={fplId}
            onChange={(e) => setFplId(e.target.value)}
            error={!idValid ? "Must be a positive number." : undefined}
            hint={
              idValid && !idChanged
                ? "Find this in your FPL account URL (/entry/1234567/…)."
                : undefined
            }
          />

          {idValid && idChanged && (
            <Callout tone="success" title="Valid">
              We&apos;ll reload your squad from FPL on save.
            </Callout>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button
              type="submit"
              fullWidth
              disabled={saving || !idValid}
            >
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={close}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </form>
      </BottomSheet>
    </>
  );
}
