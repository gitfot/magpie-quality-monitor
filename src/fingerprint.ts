import { createHash, randomUUID } from "node:crypto";
import { HTTPError, type Execution } from "./types.ts";

export const samplingProtocol = "number-1-355-v1";
export const samplingPrompt =
  "请从1到355中选择一个数字。只输出这个数字，不要输出任何其他内容。不要调用工具。";
export const scoringMethod = "100*(1-sqrt(jsd-base2))-v1";
export interface Baseline {
  id: string;
  name: string;
  model: string;
  distribution: number[];
  sampleCount: number | null;
  source: string;
  collectedAt: string | null;
  license: string;
  archived: boolean;
}
export interface FingerprintRow {
  id: string;
  name: string;
  target: string;
  effort: string;
  baselineId: string;
  enabled: boolean;
}
export interface FingerprintObject {
  type: "fingerprint";
  id: string;
  version: number;
  name: string;
  enabled: boolean;
  samples: number;
  timeoutSeconds: number;
  intervalMinutes: number;
  nextAt: number | null;
  lastDurationMs?: number;
  lastFinishedAt?: number;
  rows: FingerprintRow[];
}
export interface FingerprintSample {
  id: string;
  at: number;
  finishedAt: number;
  call: Execution["call"];
  value: number | null;
  invalid: "format" | "tools" | "call" | null;
  raw: string;
  error: string | null;
  usage: unknown;
  cli: NonNullable<Execution["cli"]>;
}
export interface FingerprintBatch {
  id: string;
  roundId: string;
  objectId: string;
  rowId: string;
  at: number;
  finishedAt: number | null;
  snapshot: FingerprintObject;
  row: FingerprintRow;
  baseline: Baseline;
  historyKey: string;
  protocol: string;
  method: string;
  attempted: number;
  valid: number;
  success: number;
  counts: number[];
  score: number | null;
  reason:
    | "running"
    | "interrupted"
    | "calls-failed"
    | "insufficient"
    | "valid-rate"
    | null;
}
export function numberSetting(v: unknown, fallback: number, max: number) {
  const n = v ?? fallback;
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > max)
    throw new HTTPError(400, "Invalid numeric setting");
  return n as number;
}
function text(v: unknown, max = 300): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\r\n\0]/.test(v)
  )
    throw new HTTPError(400, "Invalid fingerprint text");
  return v;
}
export function fingerprintKey(o: FingerprintObject, r: FingerprintRow) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        r.target,
        r.effort,
        r.baselineId,
        o.samples,
        o.timeoutSeconds,
        samplingProtocol,
      ]),
    )
    .digest("hex");
}
export function validateFingerprint(
  input: unknown,
  old?: FingerprintObject,
): FingerprintObject {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HTTPError(400, "Expected object");
  const v = input as Record<string, any>;
  if (
    v.type !== "fingerprint" ||
    !Array.isArray(v.rows) ||
    !v.rows.length ||
    v.rows.length > 50
  )
    throw new HTTPError(400, "Expected fingerprint model rows (1–50)");
  const ids = new Set();
  const rows = v.rows.map((r: any): FingerprintRow => {
    if (!r || typeof r !== "object")
      throw new HTTPError(400, "Invalid model row");
    const id = old?.rows.find((x) => x.id === r.id)?.id ?? randomUUID();
    if (ids.has(id)) throw new HTTPError(400, "Duplicate model row");
    ids.add(id);
    const target = text(r.target);
    if (!/^[^\s/]+\/[^\s]+$/.test(target))
      throw new HTTPError(400, "Use a provider/model or group/id target");
    const effort = r.effort ?? "";
    if (
      ![
        "",
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ].includes(effort)
    )
      throw new HTTPError(400, "Invalid reasoning effort");
    return {
      id,
      name: text(r.name || target),
      target,
      effort,
      baselineId: text(r.baselineId, 100),
      enabled: r.enabled !== false,
    };
  });
  return {
    type: "fingerprint",
    id: old?.id ?? randomUUID(),
    version: (old?.version ?? 0) + 1,
    name: text(v.name, 200),
    rows,
    enabled: !!old && v.enabled === true,
    samples: numberSetting(v.samples, 50, 1000),
    timeoutSeconds: numberSetting(v.timeoutSeconds, 300, 3600),
    intervalMinutes: numberSetting(v.intervalMinutes, 1440, 43200),
    nextAt: old?.nextAt ?? null,
    lastDurationMs: old?.lastDurationMs,
    lastFinishedAt: old?.lastFinishedAt,
  };
}
export function parseBaseline(
  input: unknown,
  source = "Imported JSON",
  license = "Unknown; verify source permissions",
): Baseline {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HTTPError(400, "Invalid baseline JSON");
  const v = input as Record<string, any>;
  if (
    !Array.isArray(v.distribution) ||
    v.distribution.length !== 355 ||
    v.distribution.some(
      (x: unknown) => typeof x !== "number" || !Number.isFinite(x) || x < 0,
    )
  )
    throw new HTTPError(
      400,
      "Expected 355 finite nonnegative distribution values",
    );
  const sum = v.distribution.reduce((a: number, b: number) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0)
    throw new HTTPError(400, "Empty baseline distribution");
  const raw = v.rawData;
  if (
    raw !== undefined &&
    (!Array.isArray(raw) ||
      raw.length > 100000 ||
      raw.some(
        (n: unknown) =>
          !Number.isInteger(n) || (n as number) < 1 || (n as number) > 355,
      ))
  )
    throw new HTTPError(400, "Invalid baseline rawData");
  const sampleCount =
    v.iterations === undefined && raw === undefined
      ? null
      : numberSetting(v.iterations ?? raw?.length, 1, 10000000);
  const name = text(v.name || v.model, 200),
    model = text(v.model || name);
  const collectedAt =
    v.timestamp == null ? null : text(String(v.timestamp), 100);
  // Content-address immutable scientific data, not the display name. Metadata is
  // retained with the first import; a renamed identical import reuses that entry.
  const content = {
    distribution: v.distribution,
    sampleCount,
    model,
    collectedAt,
  };
  const id = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  return {
    id,
    name,
    model,
    distribution: [...v.distribution],
    sampleCount,
    source,
    license,
    collectedAt,
    archived: false,
  };
}
export function sampleValue(
  raw: string,
  tools: number,
): { value: number | null; invalid: FingerprintSample["invalid"] } {
  if (tools) return { value: null, invalid: "tools" };
  const value = raw.trim();
  const n = /^\d{1,3}$/.test(value) ? Number(value) : 0;
  return n >= 1 && n <= 355
    ? { value: n, invalid: null }
    : { value: null, invalid: "format" };
}
export function fingerprintScore(p: number[], q: number[]): number {
  const a = p.reduce((x, y) => x + y, 0),
    b = q.reduce((x, y) => x + y, 0);
  let js = 0;
  for (let i = 0; i < 355; i++) {
    const x = p[i] / a,
      y = q[i] / b,
      m = (x + y) / 2;
    if (x) js += (x * Math.log2(x / m)) / 2;
    if (y) js += (y * Math.log2(y / m)) / 2;
  }
  return Math.max(0, Math.min(100, 100 * (1 - Math.sqrt(Math.max(0, js)))));
}
export function finishBatch(
  b: FingerprintBatch,
  at: number,
  interrupted = false,
) {
  b.finishedAt = at;
  b.reason =
    interrupted || b.attempted < b.snapshot.samples
      ? "interrupted"
      : !b.success
        ? "calls-failed"
        : b.valid < 40
          ? "insufficient"
          : b.valid / b.attempted < 0.8
            ? "valid-rate"
            : null;
  b.score = b.reason
    ? null
    : fingerprintScore(b.counts, b.baseline.distribution);
}
