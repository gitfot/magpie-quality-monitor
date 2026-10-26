import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(!process.env.MAGPIE_CODEX_BINARY)(
  "installed Codex CLI speaks Responses to an isolated local gateway and returns JSONL",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "quality-real-cli-"));
    const env: Record<string, string> = {};
    for (const key of [
      "PATH",
      "SystemRoot",
      "WINDIR",
      "ComSpec",
      "PATHEXT",
      "TEMP",
      "TMP",
    ])
      if (process.env[key]) env[key] = process.env[key]!;
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, ".codex"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1,localhost",
      OTEL_SDK_DISABLED: "true",
    });
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "cli-smoke-worker.ts"),
        home,
        process.env.MAGPIE_CODEX_BINARY!,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, err).toBe(0);
      const result = JSON.parse(out.trim());
      expect(result.records[0].call, JSON.stringify(result.records[0])).toBe(
        "success",
      );
      expect(result.records[0].verdict).toBe("correct");
      expect(result.records[0].cli.version).toBeTruthy();
      expect(result.records[0].cli.threadId).toBeTruthy();
      expect(result.records[0].usage.input_tokens).toBe(13);
      expect(result.requests).toBe(1);
      expect(result.model).toBe("group/analysis");
      expect(result.effort).toBe("high");
    } finally {
      child.kill();
      await child.exited;
      rmSync(home, { recursive: true, force: true });
    }
  },
  60000,
);
