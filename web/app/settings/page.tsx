import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentUser } from "@/lib/queries";
import { Card, PageHeader } from "@/components/ui";
import SettingsForm from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await getCurrentUser(session.user.id);
  if (!user) redirect("/login");

  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your profile and FPL link." />

      <Card className="mb-6 flex items-center justify-between">
        <div>
          <p className="font-semibold text-gray-800">Your squad</p>
          <p className="mt-0.5 text-sm text-gray-500">
            Enter or edit your 15 players manually.
          </p>
        </div>
        <Link
          href="/squad/edit"
          className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white"
        >
          Pick squad
        </Link>
      </Card>

      <SettingsForm user={user} />
    </div>
  );
}
