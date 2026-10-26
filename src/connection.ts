import { readFileSync } from "node:fs";
import type { Connection } from "./types.ts";
export function connection(file: string): {
  value: Connection | null;
  reason: string;
} {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    const url = new URL(v.baseURL);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      typeof v.apiKey !== "string" ||
      !v.apiKey ||
      !Array.isArray(v.models)
    )
      throw Error();
    return {
      value: {
        baseURL: url.href.replace(/\/$/, ""),
        apiKey: v.apiKey,
        models: v.models
          .filter(
            (m: any) => typeof m.id === "string" && typeof m.name === "string",
          )
          .map((m: any) => ({
            id: m.id,
            name: m.name,
            efforts: Array.isArray(m.efforts) ? m.efforts : [],
          })),
      },
      reason: "已连接",
    };
  } catch {
    return {
      value: null,
      reason:
        "未接入或接入配置不可读取；请在 Magpie 的 Agent 页面连接「降智监测」",
    };
  }
}
export function redact(value: string, key: string) {
  const text = key ? value.split(key).join("[REDACTED]") : value;
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]");
}
