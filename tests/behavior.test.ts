import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { fixture } from "./fixture.ts";

test("a hung request times out once without grading it as an incorrect answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const o = await f.object({ timeoutSeconds: 1 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const records = (await f.api("export")).data.records;
    expect(records).toHaveLength(1);
    expect(records[0].call).toBe("timeout");
    expect(records[0].verdict).toBeNull();
    // The timeout also covers CLI probing and startup, before any upstream call.
    expect(f.calls.length).toBeLessThanOrEqual(1);
  } finally {
    release();
    await f.close();
  }
});

test("oversized gateway responses fail safely without retry or a false logic grade", async () => {
  const f = await fixture(() => ({ text: "x".repeat(8 * 1024 * 1024) }));
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const records = (await f.api("export")).data.records;
    expect(records[0].call).toBe("error");
    expect(records[0].error).toContain("8 MiB");
    expect(records[0].verdict).toBeNull();
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("editing and scheduled updates never reorder monitor action targets", async () => {
  const f = await fixture();
  try {
    const a = await f.object({ name: "First" }),
      b = await f.object({ name: "Second" });
    await f.api(`objects/${a.id}`, "PUT", { ...a, enabled: true });
    expect((await f.api("state")).data.objects.map((o: any) => o.id)).toEqual([
      a.id,
      b.id,
    ]);
    await f.app.tick();
    await f.app.idle();
    expect((await f.api("state")).data.objects.map((o: any) => o.id)).toEqual([
      a.id,
      b.id,
    ]);
  } finally {
    await f.close();
  }
});

test("pause and resume preserve configuration version; edited history remains available without response bodies in the overview", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const resumed = (
      await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true })
    ).data;
    expect(resumed.version).toBe(1);
    const paused = (
      await f.api(`objects/${o.id}`, "PUT", { ...resumed, enabled: false })
    ).data;
    expect(paused.version).toBe(1);
    const edited = (
      await f.api(`objects/${o.id}`, "PUT", { ...paused, name: "Edited" })
    ).data;
    expect(edited.version).toBe(2);
    const records = (await f.api("state")).data.records;
    expect(records).toHaveLength(1);
    expect(records[0].version).toBe(1);
    for (const key of [
      "raw",
      "artifact",
      "snapshot",
      "request",
      "test",
      "answer",
      "usage",
    ])
      expect(records[0]).not.toHaveProperty(key);
    const record = (await f.api("records/" + records[0].id)).data;
    expect(record.raw).toBe("FINAL_ANSWER: 21");
    expect(record.snapshot.name).toBe("Primary");
    await f.restart();
    expect((await f.api("state")).data.records).toEqual(records);
  } finally {
    await f.close();
  }
});

for (const [text, finish, verdict, answer] of [
  ["FINAL_ANSWER: 21", "stop", "correct", "21"],
  ["FINAL_ANSWER:  21颗  ", "stop", "correct", "21颗"],
  ["The answer is not 21.\nFINAL_ANSWER: 20", "stop", "incorrect", "20"],
  ["The answer is 21.", "stop", "format", null],
  ["FINAL_ANSWER: 21\nFINAL_ANSWER: 20", "stop", "format", null],
  ["FINAL_ANSWER: 21", "length", null, null],
] as const) {
  test(`logic response: ${verdict} / ${text}`, async () => {
    const f = await fixture(() => ({ text, finish }));
    try {
      const o = await f.object({
        tests: [
          {
            kind: "logic",
            name: "Logic",
            prompt: "Solve",
            answers: ["21", "21颗"],
          },
        ],
      });
      await f.api(`objects/${o.id}/run`, "POST", {});
      await f.app.idle();
      const state = (await f.api("state")).data;
      const detail = (await f.api("records/" + state.records[0].id)).data;
      expect(detail.verdict).toBe(verdict);
      expect(detail.answer).toBe(answer);
      expect(JSON.stringify(f.calls)).not.toContain("21颗");
    } finally {
      await f.close();
    }
  });
}

test("global serial execution, pause cancels remaining work, deletion does not resurrect history", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const a = await f.object({
      tests: [
        { kind: "logic", name: "One", prompt: "One", answers: ["21"] },
        { kind: "logic", name: "Two", prompt: "Two", answers: ["21"] },
      ],
    });
    const b = await f.object({ name: "Second" });
    await f.api("objects/" + a.id, "PUT", { ...a, enabled: true });
    await f.api("objects/" + a.id + "/run", "POST", {});
    await f.api("objects/" + b.id + "/run", "POST", {});
    expect(f.calls.length).toBeLessThanOrEqual(1);
    await f.api("objects/" + a.id, "PUT", { ...a, enabled: false });
    await f.api("objects/" + b.id, "DELETE");
    release();
    await f.app.idle();
    expect(f.calls).toHaveLength(1);
    const state = (await f.api("state")).data;
    expect(state.records).toHaveLength(1);
    expect(state.records[0].objectId).toBe(a.id);
    expect(state.objects).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
});

test("due rounds skip overlap, missed intervals do not backfill, and five-day retention removes records", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const o = await f.object();
    await f.api("objects/" + o.id, "PUT", { ...o, enabled: true });
    await f.app.tick();
    f.setNow(f.now + 31 * 60000);
    await f.app.tick();
    expect(
      (await f.api("state")).data.events.some((e: any) => e.type === "skipped"),
    ).toBe(true);
    release();
    await f.app.idle();
    expect(f.calls).toHaveLength(1);
    f.setNow(f.now + 3 * 86400000);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(2);
    expect(
      (await f.api("state")).data.events.some((e: any) => e.type === "gap"),
    ).toBe(true);
    f.setNow(f.now + 6 * 86400000);
    expect((await f.api("export")).data.records).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
});

test("snapshots remain unchanged and disconnect blocks queued requests", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const o = await f.object({
      tests: [
        { kind: "logic", name: "One", prompt: "Original", answers: ["21"] },
        { kind: "logic", name: "Two", prompt: "Second", answers: ["21"] },
      ],
    });
    await f.api("objects/" + o.id + "/run", "POST", {});
    const limit = Date.now() + 2000;
    while (!f.calls.length && Date.now() < limit)
      await new Promise((r) => setTimeout(r, 1));
    await f.api("objects/" + o.id, "PUT", {
      ...o,
      name: "Changed",
      tests: o.tests.map((t: any) => ({
        ...t,
        prompt: "Changed",
        answers: ["99"],
      })),
    });
    writeFileSync(f.connectionFile, "{}");
    release();
    await f.app.idle();
    const all = (await f.api("export")).data;
    expect(all.records).toHaveLength(1);
    expect(all.records[0].test.prompt).toBe("Original");
    expect(all.records[0].verdict).toBe("correct");
    expect(f.calls).toHaveLength(1);
    expect((await f.api("state")).data.connection.connected).toBe(false);
  } finally {
    release();
    await f.close();
  }
});

test("gateway errors are recorded once, never retried, never guessed as wrong answers", async () => {
  const f = await fixture(() => ({ status: 429 }));
  try {
    const o = await f.object({ target: "group/reasoning" });
    await f.api("objects/" + o.id + "/run", "POST", {});
    await f.app.idle();
    const data = (await f.api("export")).data;
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].model).toBe("group/reasoning");
    expect(data.records[0].call).toBe("error");
    expect(data.records[0].verdict).toBeNull();
    expect(data.records[0].error).toContain("no fallback or retry");
    expect(data.records[0].actualModel).toBeNull();
  } finally {
    await f.close();
  }
});

test("gallery is per-test, paginates 20/1, and returns a navigation-free sandbox preview", async () => {
  const hostile =
    '<!doctype html><html><body><script>parent.secret=1</script><meta http-equiv="refresh" content="0;url=https://evil.example"><a href="https://evil.example">Link</a><form action="/api/objects"><input></form><img src="https://evil.example/pixel"><svg viewBox="0 0 100 100" onload="alert(1)"><circle cx="10" cy="10" r="8" fill="green"/></svg><style>@keyframes spin{to{transform:rotate(360deg)}}</style></body></html>';
  const f = await fixture(() => ({ text: "```html\n" + hostile + "\n```" }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Art", prompt: "Draw" }],
    });
    for (let i = 0; i < 21; i++) {
      await f.api("objects/" + o.id + "/run", "POST", {});
      await f.app.idle();
      f.setNow(f.now + 1);
    }
    const first = (await f.api("gallery/" + o.tests[0].id + "?page=1")).data,
      second = (await f.api("gallery/" + o.tests[0].id + "?page=2")).data;
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(1);
    const html = first.items[0].preview;
    for (const forbidden of [
      "<script",
      "<meta",
      "<form",
      "<img",
      "href=",
      "onload=",
    ])
      expect(html).not.toContain(forbidden);
    expect(html).toContain("viewBox");
    expect(html).toContain("@keyframes");
    const record = (await f.api("records/" + first.items[0].id)).data;
    expect(record.raw).toContain("<script>");
    expect(record.extraction).toContain("围栏");
    expect(record.verdict).toBeNull();
    expect((await f.api("gallery/missing")).data.total).toBe(0);
    await f.restart();
    expect((await f.api("gallery/" + o.tests[0].id)).data.total).toBe(21);
  } finally {
    await f.close();
  }
});
