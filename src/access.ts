import { readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, basename, resolve } from "node:path";
import { TOML } from "bun";
import { findExecutable, launch, terminate } from "./codex.ts";
import { HTTPError, type Model, type Settings } from "./types.ts";

export interface AccessState {
  connected: boolean;
  reason: string;
  models: Model[];
  updatedAt: number | null;
}
export interface AccessOptions {
  codexHome?: string;
  magpiePath?: string;
  environment?: NodeJS.ProcessEnv;
  searchPath?: string;
  parentExecutable?: () => Promise<string | null>;
}

let parentExecutable: Promise<string | null> | undefined;
function parentMagpie(): Promise<string | null> {
  // The Bun plugin host is a direct child of Magpie. Inspect only that PID,
  // never enumerate unrelated processes or their command lines.
  return (parentExecutable ??= (async () => {
    if (process.platform !== "win32") return null;
    try {
      const executable = (
        await query(
          join(
            process.env.SystemRoot || "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
              `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.ppid}').ExecutablePath`,
          ],
        )
      ).trim();
      return isAbsolute(executable) &&
        /^magpie(?:-windows-(?:amd64|arm64))?\.exe$/i.test(basename(executable))
        ? executable
        : null;
    } catch {
      return null;
    }
  })());
}

// This is a deliberately narrow adapter for the existing human CLI output.
// Once explanations begin, IDs in hidden-model examples are never candidates.
export function parseCatalog(text: string): {
  models: Model[];
  baseURL: string;
} {
  const lines = text
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .trimEnd()
    .split("\n");
  const footer = lines.pop();
  if (!footer || !/^  https?:\/\/\S+\/v1$/.test(footer))
    throw Error("catalog format");
  const models: Model[] = [];
  let header = false,
    explaining = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (
      /^  (?:codex is shown|\d+ taken out of codex|!|.*: \d+ more models? in its list)/.test(
        line,
      )
    )
      explaining = true;
    if (explaining) continue;
    if (!line.startsWith("  ") || line.startsWith("    "))
      throw Error("catalog indentation");
    if (!header) {
      if (/^  \S+\/\S+/.test(line)) throw Error("ambiguous catalog header");
      header = true;
      continue;
    }
    const row = /^  ([^\s/]+\/[^\s]+)(?: {2,}(.*))?\s*$/.exec(line);
    if (!row) {
      if (line.includes(":")) throw Error("catalog explanation");
      header = true;
      continue;
    }
    if (models.some((m) => m.id === row[1]))
      throw Error("duplicate catalog ID");
    let name = row[2]?.trim() || row[1];
    const effort =
      /(?:^| {2,})((?:none|minimal|low|medium|high|xhigh|max|ultra)(?:\/(?:none|minimal|low|medium|high|xhigh|max|ultra))*)$/.exec(
        name,
      );
    const efforts = effort ? effort[1].split("/") : [];
    if (effort) name = name.slice(0, effort.index).trim() || row[1];
    models.push({ id: row[1], name, efforts });
  }
  if (!models.length) throw Error("no verified catalog");
  return { models, baseURL: footer.trim() };
}

async function query(executable: string, args: string[]): Promise<string> {
  const child = launch(executable, args, tmpdir());
  let output = "",
    bytes = 0,
    failed = false;
  const stopping: Promise<void>[] = [];
  const stop = () => {
    failed = true;
    const task = terminate(child);
    void task.catch(() => {});
    stopping.push(task);
  };
  const timer = setTimeout(stop, 10000);
  try {
    child.stdin!.on("error", () => {});
    child.stdin!.end();
    child.stderr!.resume();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) {
        if (!failed) stop();
      } else output += chunk;
    });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    if (failed || code !== 0) throw Error("CLI query failed");
    return output;
  } finally {
    clearTimeout(timer);
    await Promise.all(stopping);
  }
}

export class CodexAccess {
  private state: AccessState = {
    connected: false,
    reason: "尚未读取原生 Codex 接入与模型目录",
    models: [],
    updatedAt: null,
  };
  private baseURL = "";
  private pending: Promise<AccessState> | null = null;
  private attemptedAt = -Infinity;
  private stopped = false;
  constructor(
    private settings: () => Settings,
    private now = Date.now,
    private options: AccessOptions = {},
  ) {}

  private verify(): string | null {
    try {
      const env = this.options.environment ?? process.env;
      const home =
        this.options.codexHome ?? env.CODEX_HOME ?? join(homedir(), ".codex");
      if (!isAbsolute(home) || /^\\\\wsl[.$]/i.test(home.replace(/\//g, "\\")))
        return "仅支持 Windows 原生 Codex 配置";
      const config = TOML.parse(
        readFileSync(join(home, "config.toml"), "utf8"),
      ) as any;
      const system =
        env.ProgramData && join(env.ProgramData, "OpenAI", "Codex");
      if (
        config.profile ||
        env.OPENAI_BASE_URL ||
        env.OPENAI_API_BASE ||
        (system &&
          ["config.toml", "requirements.toml"].some((name) =>
            existsSync(join(system, name)),
          ))
      )
        return "Codex 存在未验证的配置覆盖，无法确认接入状态";
      if (config.model_provider !== "magpie")
        return "请在 Magpie Agent 页面接入原生 Codex；当前接入模式尚未验证";
      const provider = config.model_providers?.magpie;
      if (
        !provider ||
        provider.wire_api !== "responses" ||
        provider.base_url?.replace(/\/$/, "") !== this.baseURL
      )
        return "Codex 接入配置已改变或无法确认，停止新执行";
      const catalog = config.model_catalog_json;
      if (
        typeof catalog !== "string" ||
        basename(catalog) !== "magpie-models.json" ||
        !existsSync(resolve(home, catalog))
      )
        return "无法确认 Codex 的 Magpie 模型目录配置";
      if (!this.state.models.some((m) => m.id === config.model))
        return "Codex 当前模型不在已读取的可见目录中";
      return null;
    } catch {
      return "无法读取或识别原生 Codex 接入配置，停止新执行";
    }
  }
  snapshot(): AccessState {
    const reason =
      this.state.updatedAt === null || !this.state.connected
        ? this.state.reason
        : this.verify();
    return {
      ...this.state,
      connected: this.state.connected && !reason,
      reason: reason || "原生 Codex 已接入 Magpie（有限兼容检查）",
    };
  }
  async refresh(force = true): Promise<AccessState> {
    if (this.stopped) return { ...this.snapshot(), connected: false };
    if (this.pending) return this.pending;
    if (!force && this.now() - this.attemptedAt < 30000) return this.snapshot();
    this.attemptedAt = this.now();
    this.pending = (async () => {
      let reason =
        "找不到 Magpie CLI；请在设置中填写正在运行的 Magpie 可执行文件绝对路径";
      try {
        const explicit =
          this.options.magpiePath ?? this.settings().magpiePath ?? "";
        const parent = explicit
          ? null
          : await (this.options.parentExecutable ?? parentMagpie)();
        const executable = explicit
          ? findExecutable(explicit, [])
          : (parent && findExecutable(parent, [])) ||
            findExecutable(
              "",
              process.platform === "win32"
                ? [
                    "magpie.exe",
                    "magpie.cmd",
                    "magpie-windows-amd64.exe",
                    "magpie-windows-arm64.exe",
                  ]
                : ["magpie"],
              this.options.searchPath,
            );
        if (!executable) throw Error();
        reason = "无法运行 Magpie CLI；请检查路径、文件权限后刷新目录";
        const version = (await query(executable, ["--version"])).trim();
        reason = "Magpie CLI 版本不受支持；仅支持 magpie 0.1.x";
        if (!/^magpie 0\.1\.\d+$/.test(version)) throw Error();
        reason = "Magpie CLI 模型目录命令失败；请检查 Magpie 状态后刷新";
        const text = await query(executable, ["models", "codex"]);
        reason = "Magpie CLI 模型目录格式不受支持；请检查版本后刷新";
        const catalog = parseCatalog(text);
        this.baseURL = catalog.baseURL;
        this.state = {
          connected: true,
          reason: "",
          models: catalog.models,
          updatedAt: this.now(),
        };
        const connectionReason = this.verify();
        this.state.connected = !connectionReason;
        this.state.reason =
          connectionReason || "原生 Codex 已接入 Magpie（有限兼容检查）";
      } catch {
        this.state = {
          ...this.state,
          connected: false,
          reason,
        };
      }
      return this.snapshot();
    })();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
  assert(target: string) {
    const state = this.snapshot();
    if (!state.connected) throw new HTTPError(409, state.reason);
    if (!state.models.some((m) => m.id === target))
      throw new HTTPError(
        409,
        "所选模型已不在 Codex 可见目录中；请重新选择，历史仍保留",
      );
  }
  async close() {
    this.stopped = true;
    await this.pending;
  }
}
