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

// Signed points delta, e.g. 4.6 -> "+4.6", -1.2 -> "−1.2" (true minus sign).
export function formatSignedEp(ep: number | null | undefined): string {
  if (ep == null) return "—";
  const s = ep.toFixed(1);
  if (ep > 0) return `+${s}`;
  return s.replace("-", "−");
}

// Signed price delta from tenths, e.g. 5 -> "+£0.5m", -10 -> "−£1.0m".
export function formatSignedPrice(tenths: number | null | undefined): string {
  if (tenths == null) return "—";
  const abs = `£${(Math.abs(tenths) / 10).toFixed(1)}m`;
  if (tenths > 0) return `+${abs}`;
  if (tenths < 0) return `−${abs}`;
  return abs;
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
