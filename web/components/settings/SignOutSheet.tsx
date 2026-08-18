"use client";

import { LogOut } from "lucide-react";
import { signOutAction } from "@/app/actions";
import { BottomSheet, Button, Callout } from "@/components/ui";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SignOutSheet({ open, onClose }: Props) {
  return (
    <BottomSheet open={open} onClose={onClose} title="Sign out of AI Gaffer?">
      <div className="space-y-4">
        <Callout tone="info">
          Your squad and LMS picks stay saved.
        </Callout>

        <div className="flex flex-col gap-2 pt-1">
          <form action={signOutAction}>
            <Button type="submit" variant="danger" fullWidth icon={<LogOut />}>
              Sign out
            </Button>
          </form>
          <Button variant="ghost" fullWidth onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
