import { test, expect } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexAccess, parseCatalog } from "../src/access.ts";
import { launch, terminate } from "../src/codex.ts";
import { tokenTotal } from "../src/metrics.ts";
import { fixture } from "./fixture.ts";

test("synthetic Magpie catalog preserves eight model IDs, names and ultra effort", () => {
  const catalog = parseCatalog(
    readFileSync(
      join(import.meta.dir, "fixtures/magpie-catalog-example.txt"),
      "utf8",
    ),
  );
  expect(catalog.models.map((model) => model.id)).toEqual([
    "group/reasoning",
    "provider-a/model-alpha",
    "provider-a/model-beta",
    "provider-b/model-alpha",
    "provider-b/model-beta",
    "provider-c/model-alpha",
    "provider-c/model-beta",
    "provider-d/model-delta",
  ]);
  expect(catalog.models[0]).toEqual({
    id: "group/reasoning",
    name: "Reasoning route",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
  });
});

test.skipIf(process.platform !== "win32")(
  "Windows discovery reads the real parent executable outside PATH",
  async () => {
    const f = await fixture();
    try {
      const host = join(f.directory, "magpie-windows-amd64.exe");
      copyFileSync(process.execPath, host);
      const worker = `const {CodexAccess}=await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../src/access.ts")).href)});const access=new CodexAccess(()=>({retentionDays:5}),Date.now,${JSON.stringify({ codexHome: f.directory, searchPath: join(f.directory, "missing-path"), environment: {} })});try{console.log(JSON.stringify(await access.refresh()));}finally{await access.close();}`;
      const parent = `import{spawn}from 'node:child_process';const child=spawn(${JSON.stringify(process.execPath)},['-e',${JSON.stringify(worker)}],{windowsHide:true,stdio:'inherit'});child.on('error',()=>process.exit(2));child.on('close',code=>process.exit(code??1));`;
      const child = launch(host, ["-e", parent], f.directory);
      const done = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      let output = "";
      child.stdin!.end();
      child.stderr!.resume();
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (text: string) => {
        output += text;
      });
      try {
        expect(await done).toBe(0);
        // This is a renamed Bun binary, not Magpie: reaching the version check
        // proves native parent discovery succeeded without trusting its name.
        expect(JSON.parse(output).catalogError).toBe(
          "Magpie CLI 版本不受支持；仅支持 magpie 0.1.x",
        );
        expect(f.calls).toHaveLength(0);
      } finally {
        if (child.exitCode === null) await terminate(child);
        await done;
      }
    } finally {
      await f.close();
    }
  },
  30000,
);

test("catalog discovery uses the running host outside PATH without changing settings or calling models", async () => {
  const f = await fixture();
  try {
    const settings = { retentionDays: 5, magpiePath: "" };
    const access = new CodexAccess(() => settings, Date.now, {
      ...f.access,
      magpiePath: "",
      searchPath: join(f.directory, "missing-path"),
      parentExecutable: async () => f.access.magpiePath,
    });
    try {
      const state = await access.refresh();
      expect(state.connected).toBe(true);
      expect(state.models.map((m) => m.id)).toEqual([
        "test/model",
        "group/reasoning",
        "group/analysis",
      ]);
      expect(settings.magpiePath).toBe("");
      expect(f.calls).toHaveLength(0);
    } finally {
      await access.close();
    }
  } finally {
    await f.close();
  }
});

test.skipIf(process.platform !== "win32")(
  "PATH discovery recognizes Windows download filenames when parent lookup is unavailable",
  async () => {
    const f = await fixture();
    try {
      for (const arch of ["amd64", "arm64"]) {
        const path = join(f.directory, arch);
        mkdirSync(path);
        copyFileSync(
          process.execPath,
          join(path, `magpie-windows-${arch}.exe`),
        );
        const access = new CodexAccess(() => ({ retentionDays: 5 }), Date.now, {
          ...f.access,
          magpiePath: "",
          searchPath: path,
          parentExecutable: async () => null,
        });
        try {
          expect((await access.refresh()).catalogError).toBe(
            "Magpie CLI 版本不受支持；仅支持 magpie 0.1.x",
          );
        } finally {
          await access.close();
        }
      }
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

test("catalog errors identify missing CLI, launch failure, version, command and format separately", async () => {
  const f = await fixture();
  try {
    const check = async (path: string, reason: string) => {
      const access = new CodexAccess(() => ({ retentionDays: 5 }), Date.now, {
        ...f.access,
        magpiePath: path,
        searchPath: join(f.directory, "missing-path"),
        parentExecutable: async () => f.access.magpiePath,
      });
      try {
        const state = await access.refresh();
        expect(state.connected).toBe(true);
        expect(state.catalogError).toBe(reason);
      } finally {
        await access.close();
      }
    };
    await check(
      join(f.directory, "missing.exe"),
      "找不到 Magpie CLI；请在设置中填写正在运行的 Magpie 可执行文件绝对路径",
    );
    const script = join(f.directory, "magpie.mjs");
    writeFileSync(script, "process.exit(7)");
    await check(
      f.access.magpiePath,
      "无法运行 Magpie CLI；请检查路径、文件权限后刷新目录",
    );
    writeFileSync(script, "console.log('magpie 9.0.0')");
    await check(
      f.access.magpiePath,
      "Magpie CLI 版本不受支持；仅支持 magpie 0.1.x",
    );
    writeFileSync(
      script,
      "if(process.argv.includes('--version'))console.log('magpie 0.1.1543');else process.exit(8)",
    );
    await check(
      f.access.magpiePath,
      "Magpie CLI 模型目录命令失败；请检查 Magpie 状态后刷新",
    );
    writeFileSync(
      script,
      "console.log(process.argv.includes('--version')?'magpie 0.1.1543':'unknown catalog')",
    );
    await check(
      f.access.magpiePath,
      "Magpie CLI 模型目录格式不受支持；请检查版本后刷新",
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("public CLI catalog adapter excludes hidden examples, preserves full IDs and rejects unknown formats", () => {
  const text =
    "  Provider\n  test/model  A Model  low/medium/high\n  Routing groups\n  group/analysis   Analysis  high/xhigh\n  codex is shown selected\n  ! 2 kept from codex, in none of those:\n    family hidden: hidden/model, other/model\n  Provider: 2 more models in its list, not exposed (not picked): another/model\n  http://127.0.0.1:1234/v1\n";
  expect(parseCatalog(text)).toEqual({
    baseURL: "http://127.0.0.1:1234/v1",
    models: [
      { id: "test/model", name: "A Model", efforts: ["low", "medium", "high"] },
      { id: "group/analysis", name: "Analysis", efforts: ["high", "xhigh"] },
    ],
  });
  expect(
    parseCatalog(text.replace("Provider", "\x1b[2mProvider\x1b[0m")).models,
  ).toHaveLength(2);
  for (const bad of [
    "",
    "[]",
    "  changed format",
    text.replace("group/analysis", "test/model"),
    text.replace("  Provider\n", "  fake/header\n"),
  ])
    expect(() => parseCatalog(bad)).toThrow();
});

test("token totals count input and output once and treat partial or invalid telemetry as unknown", () => {
  expect(
    tokenTotal({
      input_tokens: 12000,
      output_tokens: 3500,
      cached_input_tokens: 10000,
      reasoning_output_tokens: 2000,
    }),
  ).toBe(15500);
  expect(tokenTotal({ input_tokens: 0, output_tokens: 0 })).toBe(0);
  for (const usage of [
    null,
    {},
    { input_tokens: 1 },
    { input_tokens: -1, output_tokens: 3 },
    { input_tokens: 0.5, output_tokens: 4 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  ])
    expect(tokenTotal(usage)).toBeNull();
});

test("native Codex configuration, not the former plugin Agent, gates execution and preserves enablement", async () => {
  const f = await fixture();
  try {
    expect(existsSync(join(f.directory, "connection.json"))).toBe(false);
    const o = await f.object();
    const enabled = (
      await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })
    ).data;
    const config = readFileSync(f.connectionFile, "utf8");
    for (const invalid of [
      "{}",
      config.replace('"magpie"', '"other"'),
      'profile="overridden"\n' + config,
    ]) {
      writeFileSync(f.connectionFile, invalid);
      expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(409);
      await f.app.tick();
      const state = (await f.api("state")).data;
      expect(state.records).toHaveLength(0);
      expect(state.objects[0].enabled).toBe(true);
    }
    writeFileSync(f.connectionFile, config);
    await f.api("catalog");
    await f.app.tick();
    await f.app.idle();
    expect((await f.api("export")).data.records).toHaveLength(1);
    expect(enabled.id).toBe(o.id);
  } finally {
    await f.close();
  }
});

test("local access trusts a valid provider declaration without catalog or gateway cross-checking", async () => {
  const f = await fixture();
  const config = readFileSync(f.connectionFile, "utf8");
  const access = new CodexAccess(
    () => ({ retentionDays: 5 }),
    Date.now,
    f.access,
  );
  try {
    expect(access.snapshot().models).toHaveLength(0);
    expect(access.snapshot().connected).toBe(true);
    for (const invalid of [
      config.replace('wire_api = "responses"', 'wire_api = "chat"'),
      config.replace(f.link.baseURL, "file:///not-a-gateway"),
      config.replace(f.link.baseURL, "not-a-url"),
    ]) {
      writeFileSync(f.connectionFile, invalid);
      expect(access.snapshot().connected).toBe(false);
      expect(() => access.assertConnected()).toThrow();
    }
    writeFileSync(
      f.connectionFile,
      config
        .replace(f.link.baseURL, "http://127.0.0.1:9999/v1")
        .replace('model = "test/model"', 'model = "unknown/model"'),
    );
    expect(access.snapshot().connected).toBe(true);
    expect(() => access.assertConnected()).not.toThrow();
    expect(f.calls).toHaveLength(0);
  } finally {
    await access.close();
    await f.close();
  }
});

test("removed targets and unreadable catalogs do not gate execution or configuration", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const catalog = readFileSync(f.catalogFile, "utf8");
    writeFileSync(f.catalogFile, catalog.replace(/  test\/model[^\n]*\n/, ""));
    expect((await f.api("catalog")).status).toBe(200);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    writeFileSync(f.catalogFile, "new unknown format");
    expect((await f.api("catalog")).status).toBe(409);
    const enabled = await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      name: "Keep the original target",
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(enabled.data.target).toBe("test/model");
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    expect((await f.api("export")).data.records).toHaveLength(3);
    expect((await f.api("state")).data.connection.connected).toBe(true);
    writeFileSync(f.catalogFile, catalog);
    expect((await f.api("catalog")).status).toBe(200);
    expect((await f.api("state")).data.connection.updatedAt).toBe(f.now);
  } finally {
    await f.close();
  }
});

test("cold-start execution, saving and scheduling never invoke the catalog CLI", async () => {
  const f = await fixture();
  try {
    const invoked = join(f.directory, "catalog-invoked");
    const o = await f.object();
    await f.restart();
    writeFileSync(
      join(f.directory, "magpie.mjs"),
      `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(invoked)},'called');process.exit(1);`,
    );
    expect((await f.api("state")).data.connection.connected).toBe(true);
    expect((await f.api("state")).data.connection.models).toHaveLength(0);
    expect(
      (
        await f.api("objects", "POST", {
          name: "Needs a selection",
          target: o.target,
          tests: [],
        })
      ).status,
    ).toBe(409);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    expect(
      (await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })).status,
    ).toBe(200);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(2);
    expect(existsSync(invoked)).toBe(false);
  } finally {
    await f.close();
  }
});

test("a pending catalog query does not delay saving, enabling or enqueueing", async () => {
  const f = await fixture();
  const ready = join(f.directory, "catalog-ready"),
    release = join(f.directory, "catalog-release");
  let catalog: ReturnType<typeof f.api> | undefined;
  try {
    const o = await f.object();
    writeFileSync(
      join(f.directory, "magpie.mjs"),
      `import{writeFileSync,existsSync,readFileSync}from'node:fs';
if(process.argv.includes('--version'))console.log('magpie 0.1.1549');
else{writeFileSync(${JSON.stringify(ready)},'ready');while(!existsSync(${JSON.stringify(release)}))await new Promise(r=>setTimeout(r,10));console.log(readFileSync(${JSON.stringify(f.catalogFile)},'utf8'));}`,
    );
    catalog = f.api("catalog");
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw Error("Catalog query did not start");
      await Bun.sleep(10);
    }
    const operations = (async () => {
      expect(
        (await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })).status,
      ).toBe(200);
      expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
      expect((await f.object({ name: "Another object" })).id).toBeTruthy();
    })();
    await Promise.race([
      operations,
      Bun.sleep(1500).then(() => {
        throw Error("Operations waited for the catalog");
      }),
    ]);
    expect(existsSync(release)).toBe(false);
    await f.app.idle();
    expect(f.calls).toHaveLength(1);
  } finally {
    writeFileSync(release, "release");
    await catalog;
    await f.close();
  }
});
