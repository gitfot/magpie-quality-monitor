import { test, expect } from "bun:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import http from "node:http";

const binary = process.env.MAGPIE_BINARY;
const manualSeconds = Number(process.env.MAGPIE_NATIVE_TIMEOUT_SECONDS ?? 240);
if (
  !Number.isInteger(manualSeconds) ||
  manualSeconds < 1 ||
  manualSeconds > 1200
)
  throw Error("MAGPIE_NATIVE_TIMEOUT_SECONDS must be 1-1200");
test.skipIf(!binary || !process.env.MAGPIE_CODEX_BINARY)(
  "installed Magpie connects native Codex, executes CLI model and route tests, then disconnects",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "quality-magpie-"));
    const calls: any[] = [];
    const mock = http.createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.end(JSON.stringify({ data: [{ id: "model" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body);
      const content = body.messages?.some((message: any) => {
        const text =
          typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.map((part: any) => part.text ?? "").join("")
              : "";
        return text.includes("Draw fixture art");
      })
        ? readFileSync(
            join(import.meta.dir, "fixtures", "synthetic-artwork.html"),
            "utf8",
          )
        : "FINAL_ANSWER: 21";
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const chunk of [
          {
            id: "local",
            object: "chat.completion.chunk",
            model: "model",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason: null,
              },
            ],
          },
          {
            id: "local",
            object: "chat.completion.chunk",
            model: "model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 13,
              completion_tokens: 9,
              total_tokens: 22,
            },
          },
        ])
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          id: "local",
          object: "chat.completion",
          created: 1,
          model: "model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        }),
      );
    });
    const freePort = async () => {
      const s = http.createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const p = (s.address() as { port: number }).port;
      await new Promise<void>((r) => s.close(() => r()));
      return p;
    };
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
    const gatewayPort = await freePort(),
      webPort = await freePort(),
      webKey = "isolated-monitor-integration";
    const config = join(home, ".config", "magpie");
    mkdirSync(config, { recursive: true });
    const root = resolve(import.meta.dir, "..");
    // Use a disposable package copy because the page entry is generated at runtime.
    const packageDir = join(home, "package");
    const { cpSync } = await import("node:fs");
    cpSync(root, packageDir, {
      recursive: true,
      filter: (p) =>
        !p.includes("node_modules") && !p.includes(".test-artifacts"),
    });
    // Resolve installed dependencies without running installation scripts/network.
    const { symlinkSync, unlinkSync } = await import("node:fs");
    symlinkSync(
      join(root, "node_modules"),
      join(packageDir, "node_modules"),
      "junction",
    );
    writeFileSync(
      join(config, "plugins.json"),
      JSON.stringify({ plugins: [{ spec: packageDir }] }),
    );
    writeFileSync(
      join(config, "providers.json"),
      JSON.stringify({
        providers: [
          {
            id: "local",
            name: "Local fixture",
            chat: `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`,
            key: "mock-only",
            models: ["model"],
          },
        ],
        groups: [{ id: "reasoning", members: ["local/model"] }],
      }),
    );
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_DATA_HOME: join(home, ".data"),
      XDG_STATE_HOME: join(home, ".state"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CODEX_HOME: join(home, ".codex"),
      MAGPIE_TEST_SANDBOX: home,
      MAGPIE_NO_ACCOUNTS: "1",
      MAGPIE_NO_SHORTCUT: "1",
      MAGPIE_ADDR: `127.0.0.1:${gatewayPort}`,
      MAGPIE_WEB_KEY: webKey,
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1,localhost",
    };
    for (const k of [
      "CLAUDE_CONFIG_DIR",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
    ])
      delete env[k as keyof typeof env];
    mkdirSync(env.CODEX_HOME, { recursive: true });
    const child = spawn(
      binary!,
      ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open"],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let desktop: ReturnType<typeof spawn> | null = null;
    let logs = "";
    child.stdout.on("data", (x) => (logs += x));
    child.stderr.on("data", (x) => (logs += x));
    const web = async (path: string, method = "GET") => {
      const r = await fetch(`http://127.0.0.1:${webPort}/api/` + path, {
        method,
        headers: { Cookie: `magpie_web_${webPort}=${webKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) throw Error("Magpie " + path + ": " + (await r.text()));
      return r.json();
    };
    let diagnostic = "";
    const wait = async (fn: () => Promise<boolean>, phase = "records") => {
      const end = Date.now() + 20000;
      let lastError = "";
      while (Date.now() < end) {
        try {
          if (await fn()) return;
        } catch (error) {
          lastError = String(error);
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(
        `Integration wait failed (${phase}): ${lastError}\n${diagnostic}\n${logs.slice(-5000)}`,
      );
    };
    let failure: unknown;
    try {
      await wait(async () => {
        await web("settings");
        // Like the Installed page, explicitly start the plugin host instead of
        // depending on an unrelated background refresh winning a startup race.
        const status = await web("plugins");
        diagnostic = JSON.stringify({
          error: status.error,
          plugins: status.plugins?.map((p: any) => ({
            spec: p.spec,
            error: p.error,
          })),
        });
        return existsSync(
          join(home, ".magpie-quality-monitor", "owner", "owner.json"),
        );
      }, "plugin startup");
      await web("agents/connect/codex", "POST");
      const file = join(env.CODEX_HOME, "config.toml");
      await wait(async () => existsSync(file), "native Codex connection");
      const owner = JSON.parse(
        readFileSync(
          join(home, ".magpie-quality-monitor", "owner", "owner.json"),
          "utf8",
        ),
      );
      const api = async (path: string, method = "GET", body?: unknown) => {
        const r = await fetch(owner.url + "/api/" + path, {
          method,
          headers: {
            Authorization: "Bearer " + owner.token,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        expect(r.ok).toBe(true);
        return r.json();
      };
      await api("settings", "PUT", {
        retentionDays: 5,
        magpiePath: binary,
        codexPath: process.env.MAGPIE_CODEX_BINARY,
      });
      expect(
        (await api("catalog")).models.some((m: any) => m.id === "local/model"),
      ).toBe(true);
      if (process.env.MAGPIE_NATIVE === "manual") {
        const drawing = await api("objects", "POST", {
          name: "SVG rendering regression",
          target: "local/model",
          tests: [
            {
              name: "Fixture artwork",
              kind: "drawing",
              prompt: "Draw fixture art",
            },
          ],
        });
        await api(`objects/${drawing.id}/run`, "POST", {});
        await wait(async () =>
          (await api("state")).records.some(
            (r: any) => r.objectId === drawing.id && r.hasArtifact,
          ),
        );
      }
      for (const target of ["local/model", "group/reasoning"]) {
        const object = await api("objects", "POST", {
          name: target,
          target,
          tests: [
            { name: "Logic", kind: "logic", prompt: "Solve", answers: ["21"] },
          ],
        });
        await api("objects/" + object.id + "/run", "POST", {});
        await wait(async () => {
          const s = await api("state");
          return s.records.some((r: any) => r.objectId === object.id);
        });
        const record = (await api("export")).records.find(
          (r: any) => r.objectId === object.id,
        );
        expect(record.verdict).toBe("correct");
      }
      expect(calls.length).toBeGreaterThanOrEqual(2);
      let cliObjectId: string | undefined;
      if (process.env.MAGPIE_CODEX_BINARY) {
        await api("settings", "PUT", {
          retentionDays: 5,
          codexPath: process.env.MAGPIE_CODEX_BINARY,
        });
        // Earlier single-model CLI assertions already ran. Keep only one card for
        // native interaction, without ever changing a daily user's objects.
        if (process.env.MAGPIE_NATIVE === "manual")
          for (const object of (await api("state")).objects)
            await api("objects/" + object.id, "DELETE");
        const cliObject = await api("objects", "POST", {
          name: "Isolated native CLI check",
          backend: "codex-cli",
          target: "group/reasoning",
          effort: "high",
          tests: [
            {
              name: "CLI logic",
              kind: "logic",
              prompt: "Solve the fixed local test",
              answers: ["21"],
            },
            {
              name: "CLI drawing",
              kind: "drawing",
              prompt: "Draw fixture art",
            },
          ],
        });
        cliObjectId = cliObject.id;
        if (process.env.MAGPIE_NATIVE !== "manual") {
          await api(`objects/${cliObjectId}/run`, "POST", {});
          await wait(
            async () =>
              (await api("state")).records.filter(
                (r: any) => r.objectId === cliObjectId,
              ).length === 2,
          );
        }
      }
      if (process.env.MAGPIE_NATIVE === "manual") {
        mkdirSync(".test-artifacts", { recursive: true });
        rmSync(".test-artifacts/native-verified", { force: true });
        desktop = spawn(binary!, ["gui"], {
          env: {
            ...env,
            WEBVIEW2_USER_DATA_FOLDER: join(home, "webview-profile"),
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        desktop.stdout!.on("data", (x) => (logs += "[desktop] " + x));
        desktop.stderr!.on("data", (x) => (logs += "[desktop] " + x));
        desktop.on("exit", (code) => (logs += "[desktop exit] " + code));
        writeFileSync(
          ".test-artifacts/native-ready.json",
          JSON.stringify({ pid: desktop.pid, home }),
        );
        console.log(
          "Manual WebView2 check ready. Inspect the isolated window, then create .test-artifacts/native-verified.",
        );
        const deadline = Date.now() + manualSeconds * 1000;
        while (!existsSync(".test-artifacts/native-verified")) {
          if (Date.now() > deadline)
            throw Error("Manual native check not confirmed");
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      if (cliObjectId) {
        const records = (await api("export")).records.filter(
          (r: any) => r.objectId === cliObjectId,
        );
        expect(records).toHaveLength(2);
        expect(
          records.every(
            (r: any) => r.call === "success" && r.cli.version && r.cli.threadId,
          ),
        ).toBe(true);
        expect(records.find((r: any) => r.test.kind === "logic").verdict).toBe(
          "correct",
        );
        expect(
          records.find((r: any) => r.test.kind === "drawing").artifact,
        ).toContain("<html");
        const drawing = records.find((r: any) => r.test.kind === "drawing");
        const thumbnail = await api(`thumbnail/${drawing.id}`);
        expect(thumbnail.error).toBeUndefined();
        expect(thumbnail.dataURL).toStartWith("data:image/png;base64,");
      }
      await web("agents/disconnect/codex", "POST");
      expect((await api("state")).connection.connected).toBe(false);
      await api("retire", "POST", {});
    } catch (error) {
      failure = new Error(
        String(error) +
          "\n" +
          logs.slice(-5000).replace(/[a-f0-9]{64}/g, "<REDACTED>"),
      );
      throw failure;
    } finally {
      try {
        const owner = JSON.parse(
          readFileSync(
            join(home, ".magpie-quality-monitor", "owner", "owner.json"),
            "utf8",
          ),
        );
        await fetch(owner.url + "/api/retire", {
          method: "POST",
          headers: { Authorization: "Bearer " + owner.token },
          signal: AbortSignal.timeout(2000),
        });
      } catch {}
      if (desktop) {
        desktop.kill();
        await new Promise<void>((r) => {
          if (desktop!.exitCode !== null) return r();
          desktop!.once("exit", () => r());
        });
      }
      child.kill();
      await new Promise<void>((r) => {
        if (child.exitCode !== null) return r();
        child.once("exit", () => r());
      });
      mock.closeAllConnections();
      await new Promise<void>((r) => mock.close(() => r()));
      // WebView2 can release its profile a little after the window process exits.
      try {
        // Remove the junction itself, never recurse through shared dependencies.
        unlinkSync(join(packageDir, "node_modules"));
        if (process.platform === "win32")
          await promisify(execFile)(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              join(import.meta.dir, "cleanup-magpie.ps1"),
              "-Path",
              home,
            ],
            { windowsHide: true, timeout: 15000 },
          );
        else
          rmSync(home, {
            recursive: true,
            force: true,
            maxRetries: 15,
            retryDelay: 250,
          });
      } catch (cleanup) {
        if (failure)
          throw new AggregateError(
            [failure, cleanup],
            "Integration and cleanup failed",
          );
        throw cleanup;
      }
    }
  },
  process.env.MAGPIE_NATIVE === "manual" ? (manualSeconds + 60) * 1000 : 300000,
);
