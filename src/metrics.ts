export function tokenTotal(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = u.input_tokens,
    output = u.output_tokens;
  if (
    typeof input !== "number" ||
    typeof output !== "number" ||
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0
  )
    return null;
  const total = input + output;
  return Number.isSafeInteger(total) ? total : null;
}
