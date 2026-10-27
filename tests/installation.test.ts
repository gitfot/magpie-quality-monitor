import { test, expect } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installationActive } from "../src/installation.ts";

function installation() {
  const directory = mkdtempSync(join(tmpdir(), "quality-installation-state-"));
  const root = join(
    directory,
    "plugins",
    "node_modules",
    "magpie-quality-monitor",
  );
  mkdirSync(root, { recursive: true });
  const save = (
    entries: unknown[],
    dependencies: Record<string, string> = {},
  ) => {
    writeFileSync(
      join(directory, "plugins.json"),
      JSON.stringify({ plugins: entries }),
    );
    writeFileSync(
      join(directory, "plugins", "package.json"),
      JSON.stringify({ dependencies }),
    );
  };
  return {
    directory,
    root,
    save,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const spec of [
  "github:example/quality-monitor",
  "github:example/quality-monitor#v1.0.0",
  "https://github.com/example/quality-monitor.git",
  "example/quality-monitor",
  "git+https://example.com/quality-monitor.git",
  "magpie-quality-monitor",
  "magpie-quality-monitor@0.1.0",
]) {
  test(`installation activation resolves the installed directory for ${spec}`, () => {
    const f = installation();
    try {
      f.save([{ spec }], { "magpie-quality-monitor": spec });
      expect(installationActive(f.directory, f.root)).toBe(true);
      f.save([{ spec, off: true }], { "magpie-quality-monitor": spec });
      expect(installationActive(f.directory, f.root)).toBe(false);
    } finally {
      f.close();
    }
  });
}

test("local folders and file URLs retain activation and options checks", () => {
  const f = installation();
  try {
    for (const spec of [f.root, pathToFileURL(f.root).href]) {
      f.save([{ spec, options: { mode: "example" } }]);
      expect(installationActive(f.directory, f.root, { mode: "example" })).toBe(
        true,
      );
      expect(installationActive(f.directory, f.root)).toBe(false);
    }
  } finally {
    f.close();
  }
});

test("another installed copy cannot keep a disabled or removed GitHub copy active", () => {
  const f = installation();
  const spec = "github:example/quality-monitor";
  const other = join(f.directory, "local-copy");
  mkdirSync(other);
  try {
    const dependencies = { "magpie-quality-monitor": spec };
    f.save([{ spec, off: true }, { spec: other }], dependencies);
    expect(installationActive(f.directory, f.root)).toBe(false);
    expect(installationActive(f.directory, other)).toBe(true);
    f.save([{ spec }, { spec: other, off: true }], dependencies);
    expect(installationActive(f.directory, f.root)).toBe(true);
    expect(installationActive(f.directory, other)).toBe(false);
    f.save([{ spec: other }], dependencies);
    expect(installationActive(f.directory, f.root)).toBe(false);
    f.save([{ spec }], {
      "magpie-quality-monitor": "github:example/unrelated",
    });
    expect(installationActive(f.directory, f.root)).toBe(false);
  } finally {
    f.close();
  }
});

test("unreadable manifests and malformed entries fail closed without hiding a valid local entry", () => {
  const f = installation();
  try {
    f.save([
      null,
      { spec: 42 },
      { spec: "github:example/unresolved" },
      { spec: f.root },
    ]);
    writeFileSync(join(f.directory, "plugins", "package.json"), "{");
    expect(installationActive(f.directory, f.root)).toBe(true);
    f.save([{ spec: "github:example/unresolved" }]);
    expect(installationActive(f.directory, f.root)).toBe(false);
    writeFileSync(join(f.directory, "plugins.json"), "{");
    expect(installationActive(f.directory, f.root)).toBe(false);
  } finally {
    f.close();
  }
});

test("a GitHub installation starts through the real plugin entry and replaces its startup page", async () => {
  const home = mkdtempSync(join(tmpdir(), "quality-installation-"));
  const config = join(home, "config");
  const plugins = join(config, "plugins");
  const installed = join(plugins, "node_modules", "magpie-quality-monitor");
  const dependencies = join(installed, "node_modules");
  const spec = "github:example/quality-monitor";
  mkdirSync(installed, { recursive: true });
  const root = resolve(import.meta.dir, "..");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    for (const file of ["index.ts", "package.json", "src", "ui", "page"])
      cpSync(join(root, file), join(installed, file), { recursive: true });
    symlinkSync(join(root, "node_modules"), dependencies, "junction");
    writeFileSync(
      join(plugins, "package.json"),
      JSON.stringify({ dependencies: { "magpie-quality-monitor": spec } }),
    );
    writeFileSync(
      join(config, "plugins.json"),
      JSON.stringify({ plugins: [{ spec }] }),
    );
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
      XDG_CONFIG_HOME: join(home, ".config"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CODEX_HOME: join(home, ".codex"),
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      NO_PROXY: "127.0.0.1,localhost",
    });
    child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "installation-worker.ts"),
        join(installed, "index.ts"),
        config,
      ],
      { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const worker = child;
    const errorOutput = new Response(worker.stderr).text();
    await Promise.race([
      (async () => {
        const reader = worker.stdout.getReader();
        try {
          const result = await reader.read();
          expect(new TextDecoder().decode(result.value)).toContain(
            "entry-returned",
          );
        } finally {
          reader.releaseLock();
        }
      })(),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          worker.kill();
          reject(Error("Isolated plugin entry did not return"));
        }, 10000);
      }),
    ]);
    clearTimeout(deadline);
    const page = readFileSync(join(installed, "page", "index.html"), "utf8");
    expect(page.includes('data-monitor-url="http://127.0.0.1:')).toBe(true);
    expect(page.includes('<script src="launch.js"></script>')).toBe(true);
    const ownerFile = join(
      home,
      ".magpie-quality-monitor",
      "owner",
      "owner.json",
    );
    expect(existsSync(ownerFile)).toBe(true);
    const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
    const response = await fetch(owner.url + "/api/state", {
      headers: { Authorization: "Bearer " + owner.token },
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).objects).toEqual([]);
    worker.kill();
    await worker.exited;
    expect((await errorOutput).includes("Error")).toBe(false);
  } finally {
    clearTimeout(deadline);
    child?.kill();
    await child?.exited;
    // Unlink the junction first; cleanup never traverses shared dependencies.
    if (existsSync(dependencies)) unlinkSync(dependencies);
    rmSync(home, { recursive: true, force: true });
  }
});
