import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import type { Execution } from "./types.ts";

type CliInfo = NonNullable<Execution["cli"]>;
const limit = 8 * 1024 * 1024;

export class CodexError extends Error {
  constructor(
    message: string,
    public cli: CliInfo,
  ) {
    super(message);
  }
}

export function codexArgs(target: string, effort: string): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--disable",
    "memories",
    "-c",
    "notify=[]",
    "-c",
    "approval_policy=never",
    "-m",
    target,
  ];
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`);
  args.push("-");
  return args;
}

export function findExecutable(
  explicit: string,
  names: string[],
  searchPath = process.env.PATH ?? "",
): string | null {
  const accessible = (file: string) => {
    try {
      accessSync(
        file,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return true;
    } catch {
      return false;
    }
  };
  if (explicit)
    return isAbsolute(explicit) && accessible(explicit) ? explicit : null;
  for (const name of names)
    for (const dir of searchPath.split(delimiter)) {
      if (!dir || !isAbsolute(dir)) continue;
      const file = join(dir.replace(/^"|"$/g, ""), name);
      if (accessible(file)) return file;
    }
  return null;
}

export function codexExecutable(explicit: string): string | null {
  return findExecutable(
    explicit,
    process.platform === "win32"
      ? ["codex.cmd", "codex.exe", "codex"]
      : ["codex"],
  );
}

export function launch(
  file: string,
  args: string[],
  cwd: string,
): ChildProcess {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
    // cmd expands percent variables even in quotes. Refuse metacharacters;
    // the question is always stdin, never part of this command line.
    const safeArgs = args;
    if ([file, ...safeArgs].some((value) => /["%!^&|<>\r\n\0]/.test(value)))
      throw Error("Unsafe Windows shim argument");
    const command = `"${[file, ...safeArgs].map((arg) => `"${arg}"`).join(" ")}"`;
    return spawn(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/v:off", "/c", command],
      {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }
  return spawn(file, args, {
    cwd,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function terminate(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn(
        join(
          process.env.SystemRoot || "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/pid", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" },
      );
      killer.once("error", reject);
      killer.once("exit", (code) => {
        // 128 means the process already exited; no new PID is ever discovered or killed.
        if (code === 0 || code === 128 || child.exitCode !== null) resolve();
        else reject(Error("CLI process tree could not be stopped"));
      });
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function diagnosticKind(text: string): CliInfo["errorKind"] {
  if (
    /\b401\b|unauthori[sz]ed|authentication|not logged in|sign.?in required|invalid.*(?:key|token)/i.test(
      text,
    )
  )
    return "authentication";
  if (
    /model.*(?:not found|unsupported|not supported|does not exist|unavailable)|unknown model/i.test(
      text,
    )
  )
    return "model";
  return "execution";
}

export async function runCodex(input: {
  executable: string;
  args: string[];
  prompt: string;
  signal: AbortSignal;
  cli: CliInfo;
  onText?: (text: string) => void;
}): Promise<{ raw: string; usage: unknown }> {
  const { signal, cli } = input;
  const fail = (kind: CliInfo["errorKind"], message: string): never => {
    cli.errorKind = kind;
    throw new CodexError(message, cli);
  };
  const executable = codexExecutable(input.executable);
  if (!executable)
    return fail(
      "unavailable",
      "Codex CLI unavailable; configure an executable path in Settings.",
    );
  const cwd = mkdtempSync(join(tmpdir(), "quality-codex-"));
  // No rollout/tool payload/stderr is persisted. Only whitelisted telemetry and
  // the final assistant text leave this adapter.
  const execute = async (
    args: string[],
    prompt: string,
    onLine: (line: string) => void,
  ) => {
    signal.throwIfAborted();
    let child: ChildProcess;
    try {
      child = launch(executable, args, cwd);
    } catch {
      return fail(
        "unavailable",
        "Codex CLI could not be started (check executable/shim path).",
      );
    }
    let bytes = 0,
      pending = "",
      diagnostics = "",
      problem = "";
    let killing: Promise<void> | undefined;
    const stop = () => {
      killing ??= terminate(child);
      // Observe immediately; the error is rethrown after close.
      void killing.catch(() => {});
    };
    const abort = () => stop();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) stop();
    child.stdin!.on("error", () => {});
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        problem = "Codex CLI output exceeded 8 MiB safety limit.";
        stop();
        return;
      }
      if (problem) return;
      pending += chunk;
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (!line) continue;
        try {
          onLine(line);
        } catch {
          problem = "Codex CLI returned invalid JSONL events.";
          stop();
          break;
        }
      }
    });
    child.stderr!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limit) {
        problem = "Codex CLI output exceeded 8 MiB safety limit.";
        stop();
      }
      diagnostics = (diagnostics + chunk).slice(-16000);
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
        child.stdin!.end(prompt);
      });
      if (args[0] === "exec") cli.exitCode = code;
      await killing;
      signal.throwIfAborted();
      if (problem) return fail("protocol", problem);
      if (pending.trim()) {
        try {
          onLine(pending.trim());
        } catch {
          return fail("protocol", "Codex CLI returned invalid JSONL events.");
        }
      }
      return { code, diagnostics };
    } catch (error) {
      if (signal.aborted || error instanceof CodexError) throw error;
      return fail(
        "unavailable",
        "Codex CLI process failed to start or stop safely.",
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  try {
    // The bounded version probe shares the request timeout and process-tree cancellation.
    const version = await execute(["--version"], "", (line) => {
      const match = /^codex(?:-cli)?\s+([0-9][\w.+-]{0,80})$/.exec(line);
      if (match) cli.version = match[1];
    });
    if (version.code !== 0)
      return fail("unavailable", "Codex CLI version probe failed.");
    let raw = "",
      usage: unknown = null,
      missingUsage = false,
      completed = false,
      failure = "",
      protocolError = false;
    const result = await execute(input.args, input.prompt, (line) => {
      const event = JSON.parse(line);
      if (!event || typeof event.type !== "string") {
        protocolError = true;
        return;
      }
      if (event.type === "thread.started") {
        if (
          typeof event.thread_id === "string" &&
          /^[\w-]{1,128}$/.test(event.thread_id)
        )
          cli.threadId = event.thread_id;
        else protocolError = true;
      }
      if (event.type === "item.completed") {
        if (event.item?.type === "agent_message") {
          if (typeof event.item.text !== "string") protocolError = true;
          else {
            raw = event.item.text;
            input.onText?.(raw);
          }
        } else if (
          [
            "command_execution",
            "mcp_tool_call",
            "web_search",
            "file_change",
          ].includes(event.item?.type)
        )
          cli.toolEvents++;
      }
      if (
        (event.type === "item.started" || event.type === "item.updated") &&
        [
          "command_execution",
          "mcp_tool_call",
          "web_search",
          "file_change",
        ].includes(event.item?.type)
      )
        cli.toolEvents++;
      if (event.type === "turn.completed") {
        completed = true;
        if (event.usage && typeof event.usage === "object") {
          const numbers = Object.fromEntries(
            [
              "input_tokens",
              "cached_input_tokens",
              "output_tokens",
              "reasoning_output_tokens",
            ]
              .filter(
                (k) =>
                  Number.isSafeInteger(event.usage[k]) && event.usage[k] >= 0,
              )
              .map((k) => [k, event.usage[k]]),
          );
          if (
            numbers.input_tokens === undefined ||
            numbers.output_tokens === undefined
          )
            missingUsage = true;
          const totals = {
            ...((usage as Record<string, number> | null) ?? {}),
          };
          for (const [key, value] of Object.entries(numbers)) {
            totals[key] = (totals[key] ?? 0) + value;
            if (!Number.isSafeInteger(totals[key])) protocolError = true;
          }
          if (Object.keys(totals).length) usage = totals;
        } else missingUsage = true;
      }
      if (event.type === "turn.failed" || event.type === "error")
        failure = String(
          event.error?.message ?? event.message ?? "CLI turn failed",
        );
    });
    cli.exitCode = result.code;
    if (failure || result.code !== 0) {
      // A structured turn failure is authoritative; unrelated startup warnings
      // (such as missing model metadata) must not relabel a gateway failure.
      const kind = diagnosticKind(failure || result.diagnostics);
      return fail(
        kind,
        `Codex CLI ${kind} failure (exit ${result.code ?? "unknown"}); no fallback or retry. Diagnostics omitted for privacy.`,
      );
    }
    if (protocolError || !completed || !raw.trim())
      return fail(
        "protocol",
        "Codex CLI returned no complete text turn; result not graded.",
      );
    return { raw, usage: missingUsage ? null : usage };
  } finally {
    // Target is the exact directory returned by mkdtemp, never a user-supplied path.
    rmSync(cwd, { recursive: true, force: true });
  }
}
