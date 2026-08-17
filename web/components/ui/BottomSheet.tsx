"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Mobile bottom sheet that becomes a centred dialog at >= md. Backdrop blur,
 * drag handle, focus-trap, Esc / backdrop to close, reduced-motion aware.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
}: BottomSheetProps) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastActive = useRef<HTMLElement | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    lastActive.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.clearTimeout(t);
      lastActive.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = panel.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!mounted || !open) return null;

  return createPortal(
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="fixed inset-0 z-50 flex items-end justify-center md:items-center"
      onKeyDown={onKeyDown}
    >
      <div
        className="bs-backdrop absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        className={cn(
          "bs-panel relative flex max-h-[85vh] w-full flex-col overflow-hidden border border-subtle bg-surface shadow-sheet outline-none",
          "rounded-t-xl pb-[env(safe-area-inset-bottom)] md:w-full md:max-w-md md:rounded-xl md:pb-0",
          className,
        )}
      >
        <div className="flex justify-center pt-2.5 md:hidden" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-strong" />
        </div>
        {title && (
          <div className="px-5 pb-3 pt-3">
            <h2 className="text-base font-semibold text-primary">{title}</h2>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-1">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
