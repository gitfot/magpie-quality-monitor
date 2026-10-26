import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture } from "./fixture.ts";

test("final answers tolerate presentation, not substrings or conflicting answers", async () => {
  let answer = "21 个";
  const f = await fixture(() => ({
    text: "Reasoning mentions 21.\nFINAL_ANSWER: " + answer,
  }));
  try {
    const o = await f.object({
      tests: [
        {
          kind: "logic",
          name: "Candy",
          prompt: "Solve",
          answers: ["21", "21个"],
        },
      ],
    });
    for (const [text, verdict] of [
      ["21 个", "correct"],
      ["２１个。", "correct"],
      ["21\t个.", "correct"],
      ["121", "incorrect"],
      ["210", "incorrect"],
      ["21.5", "incorrect"],
      ["-21", "incorrect"],
      ["不是21，是22", "incorrect"],
      ["21或22", "incorrect"],
    ]) {
      answer = text!;
      await f.api(`objects/${o.id}/run`, "POST", {});
      await f.app.idle();
      const records = (await f.api("export")).data.records;
      expect(records.find((r: any) => r.answer === text)?.verdict).toBe(
        verdict,
      );
    }
  } finally {
    await f.close();
  }
});

test("upgrading grading rules advances old objects once and never rewrites history", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    const activated = (
      await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })
    ).data;
    const compatible = await f.object({
      name: "Full text",
      tests: [
        {
          kind: "logic",
          name: "Full text",
          prompt: "Solve",
          answers: ["21"],
          gradingMode: "full-text",
        },
      ],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const before = (await f.api("export")).data.records;
    await f.app.close();
    const db = new Database(join(f.directory, "monitor.sqlite"));
    for (const t of activated.tests) delete t.answerRule;
    db.query("UPDATE objects SET value=? WHERE id=?").run(
      JSON.stringify(activated),
      o.id,
    );
    db.close();
    await f.restart();
    const migrated = (await f.api("state")).data.objects[0];
    expect(migrated.version).toBe(o.version + 1);
    expect(migrated.tests[0].answerRule).toBe("normalized-v1");
    expect(migrated.enabled).toBe(true);
    expect(migrated.nextAt).toBe(activated.nextAt);
    expect(
      (await f.api("state")).data.objects.find(
        (x: any) => x.id === compatible.id,
      ).version,
    ).toBe(compatible.version);
    expect((await f.api("export")).data.records).toEqual(before);
    await f.restart();
    expect((await f.api("state")).data.objects[0].version).toBe(
      migrated.version,
    );
  } finally {
    await f.close();
  }
});

test("state separates the active request from paused objects queued behind it", async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  const f = await fixture(async () => {
    entered();
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const a = await f.object(),
      b = await f.object({ name: "Queued" });
    await f.api(`objects/${a.id}/run`, "POST", {});
    await started;
    await f.api(`objects/${b.id}/run`, "POST", {});
    const s = (await f.api("state")).data;
    expect(s.running).toBe(a.id);
    expect(s.queued).toEqual([b.id]);
    expect(s.objects.every((o: any) => !o.enabled)).toBe(true);
    const enabled = (
      await f.api(`objects/${b.id}`, "PUT", { ...b, enabled: true })
    ).data;
    await f.api(`objects/${b.id}`, "PUT", { ...enabled, enabled: false });
    const cancelled = (await f.api("state")).data;
    expect(cancelled.queued).toEqual([]);
    expect(cancelled.busy).toEqual([a.id]);
    release();
    await f.app.idle();
    expect((await f.api("state")).data.running).toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
});
