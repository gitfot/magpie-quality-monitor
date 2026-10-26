export interface TestItem {
  id: string;
  name: string;
  kind: "logic" | "drawing";
  prompt: string;
  answers: string[];
  enabled: boolean;
  maxTokens: number;
  gradingMode?: "final-answer" | "full-text";
  answerRule?: "normalized-v1";
}
export type Backend = "direct-gateway" | "codex-cli";
export interface MonitorObject {
  id: string;
  version: number;
  name: string;
  target: string;
  backend?: Backend;
  effort: string;
  enabled: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
  nextAt: number | null;
  needsConversion?: boolean;
  tests: TestItem[];
}
export interface Settings {
  retentionDays: number;
  codexPath?: string;
  magpiePath?: string;
  browserPath?: string;
}
export interface Thumbnail {
  png?: Uint8Array;
  width?: number;
  height?: number;
  clipped?: boolean;
  error?: "browser" | "render" | "limit" | "busy" | "stopped";
}
export interface Model {
  id: string;
  name: string;
  efforts?: string[];
}
export interface Connection {
  baseURL: string;
  apiKey: string;
  models: Model[];
}
export interface Execution {
  id: string;
  objectId: string;
  testId: string;
  at: number;
  finishedAt: number;
  snapshot: MonitorObject;
  test: TestItem;
  request: Record<string, unknown>;
  call: "success" | "error" | "timeout" | "interrupted";
  verdict: "correct" | "incorrect" | "format" | "truncated" | null;
  answer: string | null;
  raw: string;
  error: string | null;
  usage: unknown;
  artifact: string | null;
  extraction: string | null;
  actualModel: string | null;
  backend?: Backend;
  transport?: "chat-completions" | "codex-exec";
  toolPolicy?: "none" | "cli-read-only";
  maxTokensEnforced?: boolean;
  cli?: {
    version: string | null;
    threadId: string | null;
    exitCode: number | null;
    toolEvents: number;
    errorKind:
      | "unavailable"
      | "authentication"
      | "model"
      | "protocol"
      | "execution"
      | null;
  };
}
export interface MonitorEvent {
  id: string;
  objectId: string;
  at: number;
  type: string;
  message: string;
}
export class HTTPError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
