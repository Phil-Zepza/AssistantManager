"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveFplEntryId } from "@/app/actions";

// Shown on the dashboard when the user has no fpl_entry_id yet. The write is
// done by a server action scoped to the session user id — no client-side DB call.
export default function FplIdOnboard({ userId: _userId }: { userId: number }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a valid numeric FPL team ID.");
      return;
    }
    setSaving(true);
    setError("");

    try {
      await saveFplEntryId(parsed);
      router.refresh();
    } catch {
      setError("Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-subtle bg-surface p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-accent">Connect your FPL team</h2>
      <p className="mt-1 text-sm text-secondary">
        Enter your FPL team (entry) ID so we can load your squad and make
        recommendations. You can find it in the URL of your FPL points page:
        <br />
        <code className="text-xs">
          fantasy.premierleague.com/entry/<b>1234567</b>/event/1
        </code>
      </p>
      <form onSubmit={save} className="mt-4 flex gap-2">
        <input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 1234567"
          className="w-full rounded-lg border border-strong px-3 py-2 text-base focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={saving}
          className="whitespace-nowrap rounded-lg bg-accent px-4 py-2 font-semibold text-on-accent disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
