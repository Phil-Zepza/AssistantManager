"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveSettings, signOutAction } from "@/app/actions";
import type { User } from "@/lib/types";

export default function SettingsForm({ user }: { user: User }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(user.display_name ?? "");
  const [fplId, setFplId] = useState(
    user.fpl_entry_id != null ? String(user.fpl_entry_id) : "",
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);

    let parsedFplId: number | null = null;
    if (fplId.trim() !== "") {
      const n = parseInt(fplId, 10);
      if (!Number.isFinite(n) || n <= 0) {
        setSaving(false);
        setMsg({ ok: false, text: "FPL team ID must be a positive number." });
        return;
      }
      parsedFplId = n;
    }

    try {
      await saveSettings({
        displayName: displayName.trim() || null,
        fplEntryId: parsedFplId,
      });
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } catch {
      setMsg({ ok: false, text: "Could not save. Please try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={save}
        className="space-y-4 rounded-xl border border-subtle bg-surface p-5 shadow-sm"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-secondary">
            Email
          </label>
          <input
            value={user.email ?? ""}
            disabled
            className="w-full rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-base text-secondary"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-secondary">
            Display name
          </label>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your name"
            className="w-full rounded-lg border border-strong px-3 py-2 text-base focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-secondary">
            FPL team ID
          </label>
          <input
            inputMode="numeric"
            value={fplId}
            onChange={(e) => setFplId(e.target.value)}
            placeholder="e.g. 1234567"
            className="w-full rounded-lg border border-strong px-3 py-2 text-base focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <button
          type="submit"
          disabled={saving}
          className="w-full rounded-lg bg-accent px-4 py-2.5 font-semibold text-on-accent disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save changes"}
        </button>

        {msg && (
          <p
            className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}
          >
            {msg.text}
          </p>
        )}
      </form>

      <form action={signOutAction}>
        <button
          type="submit"
          className="w-full rounded-lg border border-strong bg-surface px-4 py-2.5 font-semibold text-secondary hover:bg-surface-2"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
