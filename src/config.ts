import { createHash, randomUUID } from "node:crypto";
import { HTTPError, type MonitorObject, type TestItem } from "./types.ts";

function text(value: unknown, label: string, max = 100000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HTTPError(400, `Invalid ${label}`);
  return value;
}
function integer(value: unknown, fallback: number, max: number) {
  const n = value ?? fallback;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max)
    throw new HTTPError(400, "Invalid numeric setting");
  return n;
}
// Sibling membership and scheduling do not change this question's experiment.
export function historyKey(object: MonitorObject, test: TestItem): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        target: object.target,
        backend: object.backend ?? "direct-gateway",
        effort: object.effort,
        timeoutSeconds: object.timeoutSeconds,
        kind: test.kind,
        prompt: test.prompt,
        answers: test.answers,
        maxTokens: test.maxTokens,
        gradingMode: test.gradingMode ?? "final-answer",
        answerRule: test.answerRule ?? "exact-v0",
      }),
    )
    .digest("hex");
}
export function validate(input: unknown, old?: MonitorObject): MonitorObject {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new HTTPError(400, "Expected object");
  const v = input as Record<string, unknown>;
  const target = text(v.target, "target", 300);
  if (!/^[^\s/]+\/.+/.test(target) || /[\r\n]/.test(target))
    throw new HTTPError(400, "Use a provider/model or group/id target");
  const backend =
    v.backend ??
    (old?.needsConversion ? undefined : old?.backend) ??
    "codex-cli";
  if (backend !== "codex-cli")
    throw new HTTPError(
      400,
      "仅支持 Codex CLI；旧直连对象须在编辑页明确确认转换",
    );
  if (old?.needsConversion && v.backend !== "codex-cli")
    throw new HTTPError(409, "请在编辑页明确确认转为 Codex CLI");
  const effort = String(v.effort ?? "");
  if (
    !["", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      effort,
    )
  )
    throw new HTTPError(400, "Invalid reasoning effort");
  if (!Array.isArray(v.tests) || v.tests.length > 50)
    throw new HTTPError(400, "Expected up to 50 tests");
  const ids = new Set<string>();
  const tests = v.tests.map((x): TestItem => {
    if (!x || typeof x !== "object" || !["logic", "drawing"].includes(x.kind))
      throw new HTTPError(400, "Invalid test");
    const id = old?.tests.find((t) => t.id === x.id)?.id ?? randomUUID();
    if (ids.has(id)) throw new HTTPError(400, "Duplicate test");
    ids.add(id);
    const answers = x.kind === "logic" ? x.answers : [];
    const gradingMode =
      x.kind === "logic" ? (x.gradingMode ?? "final-answer") : "final-answer";
    if (!["final-answer", "full-text"].includes(gradingMode))
      throw new HTTPError(400, "Invalid grading mode");
    if (
      !Array.isArray(answers) ||
      (x.kind === "logic" && !answers.length) ||
      answers.length > 30
    )
      throw new HTTPError(400, "Logic tests need answers");
    return {
      id,
      name: text(x.name, "test name", 200),
      kind: x.kind,
      prompt: text(x.prompt, "prompt"),
      answers: answers.map((a) => text(a, "answer", 1000)),
      enabled: x.enabled !== false,
      gradingMode,
      ...(x.kind === "logic" && gradingMode === "final-answer"
        ? { answerRule: "normalized-v1" as const }
        : {}),
      maxTokens: integer(
        x.maxTokens,
        x.kind === "logic" ? 8192 : 16384,
        200000,
      ),
    };
  });
  const object: MonitorObject = {
    id: old?.id ?? randomUUID(),
    version: (old?.version ?? 0) + 1,
    name: text(v.name, "name", 200),
    target,
    backend,
    effort,
    enabled: old && !old.needsConversion ? v.enabled === true : false,
    intervalMinutes: integer(v.intervalMinutes, 30, 43200),
    timeoutSeconds: integer(v.timeoutSeconds, 300, 3600),
    nextAt: old?.nextAt ?? null,
    tests,
  };
  if (old) {
    const compared = (o: MonitorObject) =>
      JSON.stringify({
        name: o.name,
        target: o.target,
        backend: o.backend ?? "direct-gateway",
        effort: o.effort,
        intervalMinutes: o.intervalMinutes,
        timeoutSeconds: o.timeoutSeconds,
        tests: o.tests.map((t) => ({
          id: t.id,
          name: t.name,
          kind: t.kind,
          prompt: t.prompt,
          answers: t.answers,
          enabled: t.enabled,
          maxTokens: t.maxTokens,
          gradingMode: t.gradingMode ?? "final-answer",
          answerRule: t.answerRule,
        })),
      });
    if (compared(old) === compared(object)) object.version = old.version;
  }
  return object;
}
