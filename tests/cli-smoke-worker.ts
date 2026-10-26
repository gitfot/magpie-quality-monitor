import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startMonitor } from "../src/service.ts";

// This worker only runs with an isolated HOME/CODEX_HOME supplied by the test.
const [home, executable] = process.argv.slice(2);
if (process.env.CODEX_HOME !== join(home, ".codex"))
  throw Error("Isolated CODEX_HOME required");
const received: any[] = [];
const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!req.url?.endsWith("/responses")) {
    res.writeHead(404).end();
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  received.push(body);
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [
      { type: "output_text", text: "FINAL_ANSWER: 21", annotations: [] },
    ],
  };
  const response = {
    id: "resp_fixture",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "group/analysis",
    output: [message],
    usage: {
      input_tokens: 13,
      output_tokens: 9,
      total_tokens: 22,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  for (const event of [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "FINAL_ANSWER: 21",
    },
    {
      type: "response.output_text.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      text: "FINAL_ANSWER: 21",
    },
    {
      type: "response.content_part.done",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      part: message.content[0],
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
mkdirSync(process.env.CODEX_HOME!, { recursive: true });
writeFileSync(
  join(process.env.CODEX_HOME!, "config.toml"),
  `model = "group/analysis"\nmodel_provider = "magpie"\nmodel_catalog_json = "magpie-models.json"\n[model_providers.magpie]\nname = "Local fixture"\nbase_url = "${baseURL}"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "local-only"\nrequest_max_retries = 0\nstream_max_retries = 0\n`,
);
const directory = join(home, "monitor");
mkdirSync(directory);
writeFileSync(
  join(process.env.CODEX_HOME!, "magpie-models.json"),
  JSON.stringify({ models: [] }),
);
const magpieScript = join(home, "fake-magpie.mjs"),
  magpiePath = join(
    home,
    process.platform === "win32" ? "magpie.cmd" : "magpie",
  );
writeFileSync(
  magpieScript,
  `console.log(process.argv.includes('--version')?'magpie 0.1.1324':${JSON.stringify("  Local fixture\n  group/analysis  Fixture route  high\n  codex is shown every provider's models\n" + baseURL + "\n")});`,
);
writeFileSync(
  magpiePath,
  process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${magpieScript}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath}' '${magpieScript}' "$@"\n`,
  { mode: 0o700 },
);
const app = await startMonitor({
  directory,
  timers: false,
  access: { codexHome: process.env.CODEX_HOME, magpiePath },
});
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(app.url + "/api/" + route, {
    method,
    headers: {
      Authorization: "Bearer " + app.token,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`Monitor ${route} failed`);
  return response.json();
};
try {
  await api("settings", "PUT", { retentionDays: 5, codexPath: executable });
  const o = await api("objects", "POST", {
    name: "CLI smoke",
    backend: "codex-cli",
    target: "group/analysis",
    effort: "high",
    timeoutSeconds: 30,
    tests: [
      {
        kind: "logic",
        name: "Logic",
        prompt: "Reply with the requested final answer marker.",
        answers: ["21"],
      },
    ],
  });
  await api(`objects/${o.id}/run`, "POST", {});
  await app.idle();
  const records = (await api("export")).records;
  console.log(
    JSON.stringify({
      records,
      requests: received.length,
      model: received[0]?.model,
      effort: received[0]?.reasoning?.effort,
    }),
  );
} finally {
  await app.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
