// Tiny className joiner — filters out falsey values and joins with spaces.
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
