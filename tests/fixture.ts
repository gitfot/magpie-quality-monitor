import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMonitor } from "../src/service.ts";

export async function fixture(
  reply: (
    body: any,
    req: http.IncomingMessage,
  ) => unknown | Promise<unknown> = () => ({ text: "FINAL_ANSWER: 21" }),
) {
  const directory = mkdtempSync(join(tmpdir(), "quality-monitor-"));
  const calls: any[] = [];
  const gateway = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          data: [{ id: "test/model" }, { id: "group/reasoning" }],
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const r = (await reply(body, req)) as {
      text?: string;
      status?: number;
      finish?: string;
    };
    if (res.destroyed) return;
    res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        r.status
          ? { error: "Provider rejected request" }
          : {
              choices: [
                {
                  message: { content: r.text ?? "FINAL_ANSWER: 21" },
                  finish_reason: r.finish ?? "stop",
                },
              ],
            },
      ),
    );
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
  const connectionFile = join(directory, "config.toml");
  const link = {
    baseURL: `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1`,
    apiKey: "fixture-private-key",
    models: [{ id: "test/model", name: "Model", efforts: ["high"] }],
  };
  writeFileSync(
    connectionFile,
    `model_provider = "magpie"\nmodel = "test/model"\nmodel_catalog_json = "magpie-models.json"\n[model_providers.magpie]\nbase_url = ${JSON.stringify(link.baseURL)}\nwire_api = "responses"\n`,
  );
  writeFileSync(join(directory, "magpie-models.json"), "{}");
  const catalogFile = join(directory, "catalog.txt");
  writeFileSync(
    catalogFile,
    `  Fixture provider\n  test/model       Model  low/medium/high/xhigh\n  group/reasoning  Reasoning  low/medium/high\n  group/analysis        Analysis  low/medium/high\n  codex is shown every provider's models\n  ${link.baseURL}\n`,
  );
  const magpieScript = join(directory, "magpie.mjs");
  const magpiePath = join(
    directory,
    process.platform === "win32" ? "magpie.cmd" : "magpie",
  );
  writeFileSync(
    magpieScript,
    `import {readFileSync} from 'node:fs';console.log(process.argv.includes('--version')?'magpie 0.1.1324':readFileSync(${JSON.stringify(catalogFile)},'utf8'));`,
  );
  const script = join(directory, "codex.mjs");
  const executable = join(
    directory,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  writeFileSync(
    script,
    `
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('codex-cli 0.162.0-fixture');process.exit(0);}
let text='';for await(const chunk of process.stdin)text+=chunk;
const effort=args.find(a=>a.startsWith('model_reasoning_effort='))?.split('=')[1];
const response=await fetch(${JSON.stringify(link.baseURL + "/chat/completions")},{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer fixture-private-key'},body:JSON.stringify({model:args[args.indexOf('-m')+1],messages:[{role:'user',content:text}],max_tokens:Number(/输出 token 上限为 (\\d+)/.exec(text)?.[1]),...(effort?{reasoning_effort:effort}:{}),stream:false})});
const body=await response.json();const out=e=>console.log(JSON.stringify(e));
out({type:'thread.started',thread_id:'fixture-independent-thread'});
if(!response.ok){out({type:'turn.failed',error:{message:'upstream error'}});process.exit(1);}
out({type:'item.completed',item:{type:'agent_message',text:body.choices[0].message.content}});
if(body.choices[0].finish_reason!=='length')out({type:'turn.completed',usage:{input_tokens:12,output_tokens:7,cached_input_tokens:2}});
`,
  );
  const shim = (file: string, script: string) => {
    writeFileSync(
      file,
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
        : `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`,
      { mode: 0o700 },
    );
  };
  shim(magpiePath, magpieScript);
  shim(executable, script);
  let now = Date.UTC(2026, 9, 25, 10);
  const access = { codexHome: directory, magpiePath, environment: {} };
  let app = await startMonitor({
    directory,
    timers: false,
    now: () => now,
    access,
  });
  const api = async (route: string, method = "GET", body?: unknown) => {
    const res = await fetch(app.url + "/api/" + route, {
      method,
      headers: {
        Authorization: "Bearer " + app.token,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  const object = async (overrides: Record<string, unknown> = {}) =>
    (
      await api("objects", "POST", {
        name: "Primary",
        target: "test/model",
        tests: [
          { kind: "logic", name: "Logic", prompt: "Solve", answers: ["21"] },
        ],
        ...overrides,
      })
    ).data;
  await api("settings", "PUT", { retentionDays: 5, codexPath: executable });
  return {
    directory,
    connectionFile,
    catalogFile,
    access,
    link,
    calls,
    api,
    object,
    get app() {
      return app;
    },
    setNow: (n: number) => {
      now = n;
    },
    get now() {
      return now;
    },
    restart: async (port?: number) => {
      await app.close();
      app = await startMonitor({
        directory,
        timers: false,
        now: () => now,
        port,
        access,
      });
    },
    close: async () => {
      await app.close();
      gateway.closeAllConnections();
      await new Promise<void>((r) => gateway.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
