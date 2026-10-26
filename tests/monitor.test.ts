import { test, expect } from "bun:test";
import { fixture } from "./fixture.ts";

test("a new CLI monitor is paused, survives restart and has no fabricated history", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    expect(o.backend).toBe("codex-cli");
    expect(o.enabled).toBe(false);
    expect(o.intervalMinutes).toBe(30);
    expect(o.timeoutSeconds).toBe(300);
    expect(o.tests[0].maxTokens).toBe(8192);
    await f.restart();
    const state = (await f.api("state")).data;
    expect(state.objects[0].id).toBe(o.id);
    expect(state.records).toEqual([]);
    expect(state.settings.retentionDays).toBe(5);
  } finally {
    await f.close();
  }
});

test("manual CLI execution sends the question only and retains immutable local grading", async () => {
  const f = await fixture(() => ({ text: "Reasoning.\nFINAL_ANSWER: 21" }));
  try {
    const o = await f.object({
      effort: "high",
      tests: [
        {
          kind: "logic",
          name: "Logic",
          prompt: "Solve independently",
          answers: ["21", "twenty-one"],
        },
      ],
    });
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    const r = (await f.api("export")).data.records[0];
    expect(r.verdict).toBe("correct");
    expect(r.request.args).toContain("model_reasoning_effort=high");
    expect(r.request.stdin).toStartWith("Solve independently");
    expect(JSON.stringify(r.request)).not.toContain("twenty-one");
    expect(r.actualModel).toBeNull();
    expect(r.maxTokensEnforced).toBe(false);
    expect((await f.api("state")).data.records[0].tokenTotal).toBe(19);
  } finally {
    await f.close();
  }
});

test("explicit single runs accept disabled tests but scheduled and whole rounds still skip them", async () => {
  const f = await fixture();
  try {
    const o = await f.object({
      tests: [
        { kind: "logic", name: "Enabled", prompt: "Enabled", answers: ["21"] },
        {
          kind: "logic",
          name: "Disabled logic",
          prompt: "Disabled logic",
          answers: ["21"],
          enabled: false,
        },
        {
          kind: "drawing",
          name: "Disabled drawing",
          prompt: "Disabled drawing",
          enabled: false,
        },
      ],
    });
    const before = (await f.api("state")).data.objects[0];
    for (const test of o.tests.slice(1)) {
      expect(
        (await f.api(`objects/${o.id}/run`, "POST", { testId: test.id }))
          .status,
      ).toBe(202);
      await f.app.idle();
    }
    expect(
      (await f.api("export")).data.records.map((r: any) => r.testId).sort(),
    ).toEqual(
      o.tests
        .slice(1)
        .map((t: any) => t.id)
        .sort(),
    );
    expect((await f.api("state")).data.objects[0]).toEqual(before);
    expect(
      (await f.api(`objects/${o.id}/run`, "POST", { testId: "missing" }))
        .status,
    ).toBe(404);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    await f.app.idle();
    expect((await f.api("export")).data.records[0].testId).toBe(o.tests[0].id);
    await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true });
    const scheduled = (await f.api("state")).data.objects[0];
    f.setNow(scheduled.nextAt);
    await f.app.tick();
    await f.app.idle();
    const records = (await f.api("export")).data.records;
    expect(records).toHaveLength(4);
    expect(records.filter((r: any) => r.testId === o.tests[0].id)).toHaveLength(
      2,
    );
    const nextAt = (await f.api("state")).data.objects[0].nextAt;
    expect(
      (await f.api(`objects/${o.id}/run`, "POST", { testId: o.tests[1].id }))
        .status,
    ).toBe(202);
    await f.app.idle();
    const after = (await f.api("state")).data.objects[0];
    expect(after.nextAt).toBe(nextAt);
    expect(after.version).toBe(scheduled.version);
    expect(after.tests.map((t: any) => t.enabled)).toEqual([
      true,
      false,
      false,
    ]);
  } finally {
    await f.close();
  }
});
