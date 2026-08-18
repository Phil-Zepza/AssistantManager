"use client";

// Route-level error boundary for the authenticated app group. A transient
// server error (e.g. a dropped DB connection that outlived the retry budget)
// lands here as a styled, recoverable screen instead of Next's bare
// "server-side exception" digest page. `reset()` re-runs the failed render.
import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center px-6 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-surface text-muted shadow-card">
        <RefreshCw className="h-6 w-6" />
      </div>
      <h1 className="text-lg font-semibold text-primary">
        Something went wrong
      </h1>
      <p className="mx-auto mt-1 max-w-xs text-sm text-secondary">
        We hit a temporary hiccup loading this page. Please try again.
      </p>
      <div className="mt-6 w-full max-w-xs">
        <Button fullWidth onClick={() => reset()}>
          Try again
        </Button>
      </div>
      {error.digest && (
        <p className="mt-4 text-xs text-muted tnum">Ref: {error.digest}</p>
      )}
    </div>
  );
}
