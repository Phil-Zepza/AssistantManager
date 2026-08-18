"use client";

import { useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { sendMagicLink } from "@/app/actions";
import { Button, Input } from "@/components/ui";

type Status = "idle" | "sending" | "sent" | "error";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  // Resend is tracked separately so it never flips us off the success screen.
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setStatus("sending");
    setMessage("");

    const res = await sendMagicLink(trimmed);
    if (res.ok) {
      setSentTo(trimmed);
      setStatus("sent");
    } else {
      setStatus("error");
      setMessage(res.error ?? "Something went wrong.");
    }
  }

  async function handleResend() {
    if (!sentTo || resending) return;
    setResending(true);
    setResent(false);
    setResendError(null);
    const res = await sendMagicLink(sentTo);
    if (res.ok) {
      setResent(true);
    } else {
      setResendError(res.error ?? "Something went wrong.");
    }
    setResending(false);
  }

  function useDifferentEmail() {
    setStatus("idle");
    setEmail("");
    setSentTo("");
    setMessage("");
    setResent(false);
    setResendError(null);
  }

  return (
    <main className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-6 py-16">
      {/* Pitch-green top glow */}
      <div
        className="glow-pitch pointer-events-none absolute inset-x-0 top-0 h-80"
        aria-hidden
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="sr-only">AI Gaffer</h1>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo/lockup.svg"
            alt="AI Gaffer"
            className="mx-auto mb-4 h-28 w-auto"
          />
          <p className="mx-auto mt-2 max-w-xs text-sm text-secondary">
            Your Fantasy Premier League &amp; Last Man Standing edge — captain
            picks, transfers and survival, in one place.
          </p>
        </div>

        {status === "sent" ? (
          <div className="rounded-xl border border-subtle bg-surface p-6 text-center shadow-card">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-[rgba(22,225,163,0.15)] text-accent">
              <Check className="h-6 w-6" strokeWidth={3} />
            </div>
            <h2 className="text-lg font-semibold text-primary">
              Check your email
            </h2>
            <p className="mt-1 text-sm text-secondary">
              We sent a magic link to
            </p>
            <p className="mt-0.5 break-all font-medium text-primary">{sentTo}</p>
            <p className="mx-auto mt-3 max-w-xs text-xs text-muted">
              Click the link in the email to sign in. It can take a minute to
              arrive — check spam if you don&apos;t see it.
            </p>

            <div className="mt-6 space-y-1.5">
              <Button
                variant="ghost"
                fullWidth
                onClick={handleResend}
                disabled={resending}
              >
                {resending ? "Resending…" : "Resend email"}
              </Button>
              <Button variant="ghost" fullWidth onClick={useDifferentEmail}>
                Use a different email
              </Button>
            </div>

            {resent && (
              <p className="mt-3 text-sm text-accent">Sent again ✓</p>
            )}
            {resendError && (
              <p className="mt-3 text-sm text-danger">{resendError}</p>
            )}
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-4 rounded-xl border border-subtle bg-surface p-6 shadow-card"
          >
            <Input
              label="Email"
              type="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <Button
              type="submit"
              size="lg"
              fullWidth
              disabled={status === "sending"}
              iconRight={<ArrowRight />}
            >
              {status === "sending" ? "Sending…" : "Send magic link"}
            </Button>

            {status === "error" && (
              <p className="text-sm text-danger">{message}</p>
            )}

            <p className="text-center text-xs text-muted">
              No password needed — we&apos;ll email you a secure sign-in link.
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
