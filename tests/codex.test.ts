import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { cliFixture } from "./codex-fixture.ts";
import { fixture } from "./fixture.ts";
import { startMonitor } from "../src/service.ts";

test("CLI uses Magpie route IDs, exact multiline stdin, fresh context and final events for both test kinds", async () => {
  const f = await cliFixture();
  try {
    const prompt = 'Solve\n你好 %PATH% "quoted" & echo injected | > file';
    const o = await f.object({
      backend: "codex-cli",
      target: "group/analysis",
      effort: "high",
      tests: [
        {
          name: "Logic",
          kind: "logic",
          prompt,
          answers: ["21", "local-only-answer"],
        },
        { name: "Drawing", kind: "drawing", prompt: "Draw a bird" },
      ],
    });
    expect(o.backend).toBe("codex-cli");
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    const records = (await f.api("export")).data.records;
    expect(records).toHaveLength(2);
    const r = records.find((r: any) => r.test.kind === "logic");
    expect(r.call).toBe("success");
    expect(r.verdict).toBe("correct");
    expect(r.request.stdin).toStartWith(prompt);
    expect(f.receivedAll()[0].text).toBe(r.request.stdin);
    expect(f.receivedAll()[0].args).toEqual(r.request.args);
    expect(JSON.stringify(r.request)).not.toContain("local-only-answer");
    expect(r.request.args).toContain("group/analysis");
    expect(r.request.args).toContain("--ephemeral");
    expect(r.request.args).toContain("model_reasoning_effort=high");
    expect(r.request.args).toContain("approval_policy=never");
    expect(r.maxTokensEnforced).toBe(false);
    expect(r.transport).toBe("codex-exec");
    expect(r.toolPolicy).toBe("cli-read-only");
    expect(r.cli.version).toBe("0.0.1-fixture");
    expect(r.cli.threadId).toBe("fixture-thread-1");
    expect(r.cli.toolEvents).toBe(1);
    expect(r.usage).toEqual({
      input_tokens: 12,
      output_tokens: 7,
      cached_input_tokens: 2,
    });
    expect(r.actualModel).toBeNull();
    expect(JSON.stringify(records)).not.toContain("fixture-private-key");
    expect(JSON.stringify(records)).not.toContain("sk-secret");
    const received = f.received();
    expect(received.text).toStartWith("Draw a bird");
    expect(existsSync(received.cwd)).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(
      (await f.api(`gallery/${o.tests[1].id}?backend=codex-cli`)).data.total,
    ).toBe(1);
    expect((await f.api(`gallery/${o.tests[1].id}`)).data.total).toBe(1);
    await f.restart();
    expect((await f.api("export")).data.records).toEqual(records);
  } finally {
    await f.close();
  }
}, 20000);

for (const [mode, kind] of [
  ["auth", "authentication"],
  ["model", "model"],
  ["exit", "execution"],
  ["invalid", "protocol"],
  ["empty", "protocol"],
  ["incomplete", "protocol"],
  ["oversize", "protocol"],
  ["warning-and-error", "execution"],
] as const)
  test(`CLI ${mode} failure is explicit, private, ungraded and never falls back`, async () => {
    const f = await cliFixture(mode);
    try {
      const o = await f.object({ backend: "codex-cli" });
      await f.api(`objects/${o.id}/run`, "POST", {});
      await f.app.idle();
      const r = (await f.api("export")).data.records[0];
      expect(r.call).toBe("error");
      expect(r.verdict).toBeNull();
      expect(r.cli.errorKind).toBe(kind);
      expect(r.error).toBeTruthy();
      expect(JSON.stringify(r)).not.toContain("fixture-private-key");
      expect(JSON.stringify(r)).not.toContain("private-diagnostic");
      expect(f.calls).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 15000);

test("a removed model produces failed samples on each scheduled round without pausing", async () => {
  const f = await cliFixture("model");
  try {
    const o = await f.object();
    writeFileSync(f.catalogFile, "catalog unavailable");
    expect(
      (await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })).status,
    ).toBe(200);
    for (let round = 0; round < 2; round++) {
      await f.app.tick();
      await f.app.idle();
      const state = (await f.api("state")).data;
      expect(state.objects[0].enabled).toBe(true);
      expect(state.records).toHaveLength(round + 1);
      f.setNow(state.objects[0].nextAt);
    }
    const records = (await f.api("export")).data.records;
    expect(records.every((r: any) => r.call === "error")).toBe(true);
    expect(records.every((r: any) => r.verdict === null)).toBe(true);
    expect(records.every((r: any) => r.cli.errorKind === "model")).toBe(true);
    expect(f.receivedAll()).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 15000);

test("missing usage is unknown; unavailable CLI never starts the gateway transport", async () => {
  const f = await cliFixture("usage-missing");
  try {
    const o = await f.object({ backend: "codex-cli" });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    expect((await f.api("export")).data.records[0].usage).toBeNull();
    await f.api("settings", "PUT", {
      retentionDays: 5,
      codexPath: join(f.directory, "missing.exe"),
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    expect((await f.api("export")).data.records[0].cli.errorKind).toBe(
      "unavailable",
    );
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("session usage accumulates completed turns without adding cache or reasoning twice", async () => {
  const f = await cliFixture("multi-turn");
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const state = (await f.api("state")).data;
    expect(state.records[0].tokenTotal).toBe(1269);
    const r = (await f.api("export")).data.records[0];
    expect(r.usage.input_tokens).toBe(1012);
    expect(r.usage.output_tokens).toBe(257);
  } finally {
    await f.close();
  }
});

test("pausing stops subsequent questions but lets the in-flight CLI answer finish", async () => {
  const f = await cliFixture("tree");
  try {
    const o = await f.object({
      tests: [
        { kind: "logic", name: "First", prompt: "Solve", answers: ["21"] },
        {
          kind: "logic",
          name: "Second",
          prompt: "Solve again",
          answers: ["21"],
        },
      ],
    });
    const enabled = (
      await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })
    ).data;
    await f.api(`objects/${o.id}/run`, "POST", {});
    const pids = await f.ready();
    await f.api(`objects/${o.id}`, "PUT", { ...enabled, enabled: false });
    expect(() => process.kill(pids.parent, 0)).not.toThrow();
    writeFileSync(join(f.directory, "release"), "go");
    await f.app.idle();
    const records = (await f.api("export")).data.records;
    expect(records).toHaveLength(1);
    expect(records[0].call).toBe("success");
    expect(f.receivedAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const action of ["timeout", "delete", "close", "handover"] as const)
  test(`CLI ${action} stops the Windows shim and descendant before releasing the scheduler`, async () => {
    const f = await cliFixture("tree");
    let next: Awaited<ReturnType<typeof startMonitor>> | undefined;
    try {
      const o = await f.object({
        backend: "codex-cli",
        enabled: true,
        timeoutSeconds: action === "timeout" ? 3 : 30,
        tests: [
          { kind: "logic", name: "First", prompt: "First", answers: ["21"] },
          { kind: "logic", name: "Second", prompt: "Second", answers: ["21"] },
        ],
      });
      await f.api(`objects/${o.id}/run`, "POST", {});
      const pids = await f.ready();
      if (action === "delete") await f.api(`objects/${o.id}`, "DELETE");
      if (action === "close") await f.app.close();
      if (action === "handover")
        next = await startMonitor({ directory: f.directory, timers: false });
      await f.app.idle();
      for (const pid of Object.values(pids))
        expect(() => process.kill(pid, 0)).toThrow();
      if (action === "close" || action === "handover") {
        await next?.close();
        next = undefined;
        await f.restart();
      }
      const records = (await f.api("export")).data.records;
      expect(records).toHaveLength(
        action === "delete" ? 0 : action === "timeout" ? 2 : 1,
      );
      if (records.length)
        expect(records[0].call).toBe(
          action === "timeout" ? "timeout" : "interrupted",
        );
      expect(f.calls).toHaveLength(0);
    } finally {
      await next?.close();
      await f.close();
    }
  }, 20000);

test("CLI monitors are globally serial and native disconnect blocks subsequent tests", async () => {
  const f = await cliFixture("tree");
  try {
    const a = await f.object(),
      b = await f.object({ name: "Second" });
    await f.api(`objects/${a.id}/run`, "POST", {});
    await f.ready();
    await f.api(`objects/${b.id}/run`, "POST", {});
    expect(f.receivedAll()).toHaveLength(1);
    writeFileSync(join(f.directory, "release"), "go");
    await f.app.idle();
    expect(f.receivedAll()).toHaveLength(2);
    expect(f.calls).toHaveLength(0);
    writeFileSync(f.connectionFile, "{}");
    expect((await f.api(`objects/${a.id}/run`, "POST", {})).status).toBe(409);
  } finally {
    await f.close();
  }
});

test("legacy monitors require explicit conversion without rewriting records or identities", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const original = (await f.api("export")).data.records;
    await f.app.close();
    const db = new Database(join(f.directory, "monitor.sqlite"));
    delete o.backend;
    o.enabled = true;
    o.nextAt = f.now;
    db.query("UPDATE objects SET value=? WHERE id=?").run(
      JSON.stringify(o),
      o.id,
    );
    db.close();
    await f.restart();
    const legacy = (await f.api("state")).data.objects[0];
    expect(legacy.needsConversion).toBe(true);
    expect(legacy.enabled).toBe(false);
    expect(legacy.version).toBe(o.version);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(409);
    expect(
      (
        await f.api(`objects/${o.id}`, "PUT", {
          ...legacy,
          backend: "direct-gateway",
        })
      ).status,
    ).toBe(400);
    const converted = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...legacy,
        backend: "codex-cli",
        enabled: true,
      })
    ).data;
    expect(converted.enabled).toBe(false);
    expect(converted.id).toBe(o.id);
    expect(converted.tests[0].id).toBe(o.tests[0].id);
    expect((await f.api("export")).data.records).toEqual(original);
    await f.restart();
    expect((await f.api("state")).data.objects[0].backend).toBe("codex-cli");
  } finally {
    await f.close();
  }
});

test("full-text compatibility is opt-in and does not leak configured answers", async () => {
  const f = await fixture(() => ({
    text: "The intermediate result is 21, not the final answer.",
  }));
  try {
    const strict = await f.object(),
      compatible = await f.object({
        tests: [
          {
            kind: "logic",
            name: "Compatibility",
            prompt: "Solve",
            answers: ["21"],
            gradingMode: "full-text",
          },
        ],
      });
    for (const o of [strict, compatible]) {
      await f.api(`objects/${o.id}/run`, "POST", {});
      await f.app.idle();
    }
    const records = (await f.api("export")).data.records;
    expect(records.find((r: any) => r.objectId === strict.id).verdict).toBe(
      "format",
    );
    expect(records.find((r: any) => r.objectId === compatible.id).verdict).toBe(
      "correct",
    );
    expect(JSON.stringify(f.calls)).not.toContain("gradingMode");
  } finally {
    await f.close();
  }
});

test("settings paths reject commands and model selection rejects IDs outside the Codex catalog", async () => {
  const f = await cliFixture();
  try {
    expect(
      (
        await f.api("settings", "PUT", {
          retentionDays: 5,
          codexPath: "codex --unsafe",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.api("settings", "PUT", {
          retentionDays: 5,
          magpiePath: "magpie models codex",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.api("objects", "POST", {
          name: "Invalid",
          target: "unknown/model",
          tests: [],
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.api("objects", "POST", {
          name: "Direct",
          target: "test/model",
          backend: "direct-gateway",
          tests: [],
        })
      ).status,
    ).toBe(400);
    expect(f.calls).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("editing and pausing a running CLI keeps its old snapshot and saves the in-flight answer", async () => {
  const f = await cliFixture("tree");
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.ready();
    const edited = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...o,
        tests: o.tests.map((t: any) => ({
          ...t,
          prompt: "Changed",
          answers: ["99"],
        })),
      })
    ).data;
    writeFileSync(join(f.directory, "release"), "go");
    await f.app.idle();
    const old = (await f.api("export")).data.records[0];
    expect(old.test.prompt).toBe("Solve");
    expect(old.verdict).toBe("correct");
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    expect((await f.api("export")).data.records[0].test.prompt).toBe("Changed");
    expect(edited.tests[0].id).toBe(o.tests[0].id);
  } finally {
    await f.close();
  }
});
