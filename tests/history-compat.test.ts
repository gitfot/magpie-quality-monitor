import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixture.ts";

test("legacy backend artwork stays in the current gallery and summary upgrades do not rewrite snapshots", async () => {
  const f = await fixture(() => ({
    text: "<html><body>Legacy art</body></html>",
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Art", prompt: "Draw old" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const record = (await f.api("export")).data.records[0];
    await f.app.close();
    record.backend = "direct-gateway";
    record.snapshot.backend = "direct-gateway";
    record.usage = null;
    const db = new Database(join(f.directory, "monitor.sqlite"));
    db.query("UPDATE records SET value=?,summary=NULL WHERE id=?").run(
      JSON.stringify(record),
      record.id,
    );
    db.close();
    await f.restart();
    await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      tests: o.tests.map((t: any) => ({ ...t, prompt: "Draw new" })),
    });
    const state = (await f.api("state")).data;
    expect(state.records[0].backend).toBe("direct-gateway");
    expect(state.records[0].tokenTotal).toBeNull();
    expect((await f.api(`gallery/${o.tests[0].id}`)).data.total).toBe(1);
    expect((await f.api("export")).data.records[0]).toEqual(record);
    await f.restart();
    expect((await f.api("export")).data.records[0]).toEqual(record);
  } finally {
    await f.close();
  }
});

test("question comparison ignores siblings and scheduling, but separates changed experiment conditions", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    const getKey = async () =>
      (await f.api("state")).data.objects[0].tests[0].historyKey;
    const key = await getKey();
    expect(typeof key).toBe("string");
    for (const changes of [
      { name: "Renamed" },
      { intervalMinutes: 60 },
      { enabled: true },
      { tests: [{ ...o.tests[0], name: "Renamed question", enabled: false }] },
      {
        tests: [
          ...o.tests,
          { name: "Sibling", kind: "logic", prompt: "Other", answers: ["21"] },
        ],
      },
    ]) {
      await f.api(`objects/${o.id}`, "PUT", { ...o, ...changes });
      expect(await getKey()).toBe(key);
    }
    for (const changes of [
      { target: "group/reasoning" },
      { effort: "high" },
      { timeoutSeconds: 600 },
      { tests: [{ ...o.tests[0], prompt: "Changed" }] },
      { tests: [{ ...o.tests[0], answers: ["22"] }] },
      { tests: [{ ...o.tests[0], maxTokens: 1000 }] },
      { tests: [{ ...o.tests[0], gradingMode: "full-text" }] },
    ]) {
      await f.api(`objects/${o.id}`, "PUT", { ...o, ...changes });
      expect(await getKey()).not.toBe(key);
    }
  } finally {
    await f.close();
  }
});

test("existing summaries regain comparable history across object versions without rewriting execution snapshots", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const original = (await f.api("export")).data.records;
    await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      name: "Edited object",
      tests: [
        ...o.tests,
        { kind: "logic", name: "New", prompt: "New", answers: ["21"] },
      ],
    });
    await f.app.close();
    const db = new Database(join(f.directory, "monitor.sqlite"));
    db.query(
      "UPDATE records SET summary=json_remove(summary,'$.historyKey')",
    ).run();
    db.close();
    await f.restart();
    const s = (await f.api("state")).data;
    expect(s.records[0].historyKey).toBe(s.objects[0].tests[0].historyKey);
    expect(s.records[0].version).toBe(1);
    expect(s.objects[0].version).toBe(2);
    expect((await f.api("export")).data.records).toEqual(original);
    await f.restart();
    expect((await f.api("state")).data.records).toEqual(s.records);
  } finally {
    await f.close();
  }
});

test("the new screenshot renderer replaces legacy cached PNGs without rerunning the model", async () => {
  const f = await fixture(() => ({
    text: '<html><body style="height:1200px;background:navy">Stable</body></html>',
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Legacy cache", prompt: "Draw" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const id = (await f.api("state")).data.records[0].id;
    await f.api(`thumbnail/${id}`);
    const record = (await f.api(`records/${id}`)).data;
    await f.app.close();
    const db = new Database(join(f.directory, "monitor.sqlite"));
    const legacy = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS0cAAAAASUVORK5CYII=",
      "base64",
    );
    db.query(
      "UPDATE thumbnails SET renderer=?,png=?,metadata=? WHERE record_id=?",
    ).run(
      "full-page-v1:",
      legacy,
      JSON.stringify({ width: 1, height: 1, clipped: false }),
      id,
    );
    db.close();
    await f.restart();
    const result = (await f.api(`thumbnail/${id}`)).data;
    expect(result.error).toBeUndefined();
    expect(result.width).toBe(1280);
    expect(result.height).toBeGreaterThan(1000);
    expect(
      Buffer.from(result.dataURL.split(",")[1], "base64").equals(legacy),
    ).toBe(false);
    expect((await f.api(`records/${id}`)).data).toEqual(record);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
