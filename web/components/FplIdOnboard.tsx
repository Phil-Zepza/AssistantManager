"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { saveFplEntryId, skipOnboarding } from "@/app/actions";
import { Button, Card, Input } from "@/components/ui";

// Fully-styled "Link your FPL team" card (the design-system version of the PR-1
// stub). The write goes through the existing `saveFplEntryId` server action,
// scoped to the session user id — no client-side DB access.
export default function FplIdOnboard({
  initialValue = "",
  showSkip = false,
  redirectTo,
}: {
  /** Pre-fill the input (e.g. an already-stored team id). */
  initialValue?: string;
  /** Show the ghost "Do this later" action (onboarding screen only). */
  showSkip?: boolean;
  /** Where to go after a successful save; falls back to a soft refresh. */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseInt(value.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a valid numeric FPL team ID.");
      return;
    }
    setSaving(true);
    setError(null);

    try {
      await saveFplEntryId(parsed);
      if (redirectTo) router.push(redirectTo);
      else router.refresh();
    } catch {
      setError("Could not save. Please try again.");
      setSaving(false);
    }
  }

  return (
    <Card padding="lg" className="mx-auto w-full max-w-md">
      <h2 className="text-lg font-semibold text-primary">Link your FPL team</h2>
      <p className="mt-1.5 text-sm text-secondary">
        Enter your FPL team (entry) ID so we can load your squad and tailor your
        captain, transfer and survival calls.
      </p>

      <form onSubmit={save} className="mt-5 space-y-4">
        <Input
          label="FPL team ID"
          inputMode="numeric"
          pattern="[0-9]*"
          autoFocus
          placeholder="e.g. 1234567"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          hint={
            <>
              Find this in your FPL account URL:{" "}
              <code className="text-muted">
                /entry/<span className="text-secondary">1234567</span>/…
              </code>
            </>
          }
          error={error ?? undefined}
        />

        <Button
          type="submit"
          size="lg"
          fullWidth
          disabled={saving}
          iconRight={<ArrowRight />}
        >
          {saving ? "Saving…" : "Continue"}
        </Button>
      </form>

      {showSkip && (
        <form action={skipOnboarding} className="mt-2">
          <Button type="submit" variant="ghost" fullWidth disabled={saving}>
            Do this later
          </Button>
        </form>
      )}
    </Card>
  );
}
