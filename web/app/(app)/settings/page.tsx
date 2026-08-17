import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentUser } from "@/lib/queries";
import { PageHeader } from "@/components/ui";
import { SettingsCanvas } from "@/components/settings/SettingsCanvas";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await getCurrentUser(session.user.id);
  if (!user) redirect("/login");

  return (
    <div>
      <PageHeader title="Settings" subtitle="Account, reminders and app preferences." />
      <SettingsCanvas user={user} />
    </div>
  );
}
