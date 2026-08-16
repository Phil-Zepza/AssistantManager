// Small display helpers.

// Price is stored in tenths of a million (155 -> "£15.5m").
export function formatPrice(tenths: number | null | undefined): string {
  if (tenths == null) return "—";
  return `£${(tenths / 10).toFixed(1)}m`;
}

export function formatEp(ep: number | null | undefined): string {
  if (ep == null) return "—";
  return ep.toFixed(1);
}

export function formatPct(p: number | null | undefined): string {
  if (p == null) return "—";
  return `${Math.round(p * 100)}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
