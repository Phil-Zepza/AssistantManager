import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getCurrentUser, getRecommendations } from "@/lib/queries";
import { formatDate } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import type { RecommendationKind, RecommendationLog } from "@/lib/types";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<RecommendationKind, string> = {
  fpl_xi: "Starting XI",
  fpl_transfer: "Transfer",
  fpl_captain: "Captain",
  lms_pick: "LMS pick",
  chip: "Chip",
};

// Read a boolean-ish "was this correct" signal from the outcome jsonb.
function isCorrect(outcome: Record<string, unknown> | null): boolean | null {
  if (!outcome) return null;
  for (const key of ["correct", "hit", "success", "survived", "won"]) {
    if (key in outcome) {
      const v = outcome[key];
      if (typeof v === "boolean") return v;
      if (typeof v === "string")
        return ["true", "win", "yes", "correct"].includes(v.toLowerCase());
    }
  }
  if (typeof outcome["result"] === "string") {
    return (outcome["result"] as string).toLowerCase() === "win";
  }
  return null;
}

function summarisePayload(payload: Record<string, unknown> | null): string {
  if (!payload) return "—";
  for (const key of ["team", "player", "captain", "note", "chip", "summary"]) {
    if (key in payload && payload[key] != null) return String(payload[key]);
  }
  const s = JSON.stringify(payload);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

export default async function HistoryPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const userId = session.user.id;
  const user = await getCurrentUser(userId);
  if (!user) redirect("/login");

  const recs = await getRecommendations(userId);

  const resolved = recs.filter((r) => r.outcome != null);
  const correct = resolved.filter((r) => isCorrect(r.outcome) === true).length;
  const accuracy =
    resolved.length > 0 ? Math.round((correct / resolved.length) * 100) : null;

  return (
    <div>
      <PageHeader
        title="History"
        subtitle="Past recommendations and how they turned out."
      />

      {/* Accuracy tally */}
      <div className="mb-4 grid grid-cols-3 gap-2">
        <Stat label="Logged" value={String(recs.length)} />
        <Stat label="Resolved" value={String(resolved.length)} />
        <Stat
          label="Accuracy"
          value={accuracy != null ? `${accuracy}%` : "—"}
        />
      </div>

      {recs.length === 0 ? (
        <EmptyState
          title="No recommendations yet"
          hint="Once the pipeline runs, each week's captain, transfer, chip and LMS suggestions are logged here with outcomes."
        />
      ) : (
        <div className="space-y-2">
          {recs.map((r) => (
            <RecRow key={r.id} rec={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="text-center">
      <div className="text-2xl font-bold text-accent">{value}</div>
      <div className="text-xs text-secondary">{label}</div>
    </Card>
  );
}

function RecRow({ rec }: { rec: RecommendationLog }) {
  const correct = isCorrect(rec.outcome);
  return (
    <Card className="flex items-center justify-between py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Badge tone="purple">
            {KIND_LABEL[rec.kind] ?? rec.kind}
          </Badge>
          <span className="text-xs text-muted">GW {rec.gw}</span>
        </div>
        <p className="mt-1 truncate text-sm font-medium text-primary">
          {summarisePayload(rec.payload)}
        </p>
        <p className="text-xs text-muted">{formatDate(rec.created_at)}</p>
      </div>
      <div className="ml-3 shrink-0">
        {rec.outcome == null ? (
          <Badge tone="amber">Pending</Badge>
        ) : correct === true ? (
          <Badge tone="green">Hit ✓</Badge>
        ) : correct === false ? (
          <Badge tone="red">Miss ✗</Badge>
        ) : (
          <Badge tone="gray">Resolved</Badge>
        )}
      </div>
    </Card>
  );
}
