"use client";

import { useState } from "react";
import { sendMagicLink } from "@/app/actions";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("sending");
    setMessage("");

    const res = await sendMagicLink(email);

    if (res.ok) {
      setStatus("sent");
      setMessage("Check your inbox for a magic link to sign in.");
    } else {
      setStatus("error");
      setMessage(res.error ?? "Something went wrong.");
    }
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <div className="mb-8 text-center">
        <div className="mb-2 text-4xl">⚽</div>
        <h1 className="text-2xl font-bold text-brand">FPL / LMS Assistant</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sign in with a magic link — no password needed.
        </p>
      </div>

      {status === "sent" ? (
        <div className="rounded-lg border border-brand-accent bg-green-50 p-4 text-center text-sm text-gray-700">
          {message}
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </label>

          <button
            type="submit"
            disabled={status === "sending"}
            className="w-full rounded-lg bg-brand px-4 py-2.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {status === "sending" ? "Sending…" : "Send magic link"}
          </button>

          {status === "error" && (
            <p className="text-sm text-red-600">{message}</p>
          )}
        </form>
      )}
    </div>
  );
}
