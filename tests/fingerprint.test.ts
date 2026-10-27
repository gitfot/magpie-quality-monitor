import { test, expect } from "bun:test";
import { fixture } from "./fixture.ts";
import {
  fingerprintScore,
  sampleValue,
  finishBatch,
  type FingerprintBatch,
} from "../src/fingerprint.ts";

const distribution = (values: Record<number, number>) =>
  Array.from({ length: 355 }, (_, i) => values[i + 1] || 0);
const reference = (
  values: Record<number, number> = { 37: 1 },
  name = "Synthetic reference",
) => ({
  name,
  model: "synthetic/model",
  iterations: 100,
  distribution: distribution(values),
  timestamp: "2026-10-01T00:00:00Z",
});
async function create(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  const baseline = (await f.api("baselines", "POST", [reference()])).data[0];
  const response = await f.api("objects", "POST", {
    type: "fingerprint",
    name: "Fingerprint",
    rows: [{ target: "test/model", effort: "high", baselineId: baseline.id }],
    ...overrides,
  });
  expect(response.status).toBe(201);
  return { object: response.data, baseline };
}
async function waitFor(
  f: Awaited<ReturnType<typeof fixture>>,
  check: (data: any) => boolean,
) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const data = (await f.api("state")).data;
    if (check(data)) return data;
    await Bun.sleep(10);
  }
  throw Error("Observable state did not arrive");
}

test("strict sample parsing, JS distance endpoints, symmetry and score gates", () => {
  for (const raw of ["1", "355", " 37\n"])
    expect(sampleValue(raw, 0).value).toBe(Number(raw));
  for (const raw of [
    "0",
    "356",
    "-1",
    "1.0",
    "37 73",
    "Answer: 37",
    "FINAL_ANSWER: 37",
    "3e1",
    "",
  ])
    expect(sampleValue(raw, 0).value).toBeNull();
  expect(sampleValue("37", 1).invalid).toBe("tools");
  const a = distribution({ 1: 1 }),
    b = distribution({ 2: 1 }),
    c = distribution({ 1: 1, 2: 1 });
  expect(fingerprintScore(a, a)).toBe(100);
  expect(fingerprintScore(a, b)).toBe(0);
  // Independently known JSD([1,0],[.5,.5]) = .31127812445913283 bits.
  expect(fingerprintScore(a, c)).toBeCloseTo(44.2076954715856, 8);
  expect(fingerprintScore(c, a)).toBeCloseTo(fingerprintScore(a, c), 10);
  expect(fingerprintScore(distribution({ 1: 20 }), a)).toBe(100);
  for (const [budget, attempts, valid, interrupted, expected] of [
    [50, 50, 39, false, "insufficient"],
    [50, 50, 40, false, null],
    [51, 51, 40, false, "valid-rate"],
    [100, 100, 80, false, null],
    [50, 49, 49, false, "interrupted"],
    [50, 50, 50, true, "interrupted"],
  ] as const) {
    const batch = {
      snapshot: { samples: budget },
      attempted: attempts,
      valid,
      success: attempts,
      counts: distribution({ 37: valid }),
      baseline: { distribution: distribution({ 37: 1 }) },
    } as FingerprintBatch;
    finishBatch(batch, 1, interrupted);
    expect(batch.reason).toBe(expected);
    expect(batch.score).toBe(expected ? null : 100);
  }
});

test("API import is atomic, content-addressed and immutable; object defaults and separate retention", async () => {
  const f = await fixture();
  try {
    const { object: o, baseline } = await create(f);
    expect(o.samples).toBe(50);
    expect(o.intervalMinutes).toBe(1440);
    expect(o.enabled).toBe(false);
    expect((await f.api("state")).data.baselines.length).toBeGreaterThanOrEqual(
      8,
    );
    const same = (
      await f.api("baselines", "POST", [{ ...reference(), name: "renamed" }])
    ).data[0];
    expect(same.id).toBe(baseline.id);
    const different = (await f.api("baselines", "POST", [reference({ 73: 1 })]))
      .data[0];
    expect(different.id).not.toBe(baseline.id);
    const count = (await f.api("baselines")).data.length;
    expect(
      (
        await f.api("baselines", "POST", [
          reference({ 17: 1 }),
          reference({ 356: 1 }),
          { ...reference(), distribution: [1] },
        ])
      ).status,
    ).toBe(400);
    expect((await f.api("baselines")).data.length).toBe(count);
    for (const value of [-1, null, "1"]) {
      const bad = reference();
      bad.distribution[0] = value as any;
      expect((await f.api("baselines", "POST", bad)).status).toBe(400);
    }
    expect((await f.api("baselines/" + baseline.id, "DELETE")).status).toBe(
      404,
    );
    await f.api("baselines/" + baseline.id, "PUT", { archived: true });
    expect(
      (
        await f.api("objects/" + o.id, "PUT", {
          ...o,
          name: "Retained binding",
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.api("objects", "POST", { ...o, rows: o.rows })).status,
    ).toBe(400);
    const legacy = await f.object();
    expect((await f.api("objects/" + legacy.id, "PUT", { ...o })).status).toBe(
      400,
    );
    expect((await f.api("objects/" + o.id, "PUT", { ...legacy })).status).toBe(
      400,
    );
    expect(
      (
        await f.api("settings", "PUT", {
          retentionDays: 2,
          fingerprintRetentionDays: 45,
        })
      ).status,
    ).toBe(200);
    await f.restart();
    const state = (await f.api("state")).data;
    expect(state.settings.fingerprintRetentionDays).toBe(45);
    expect(state.settings.retentionDays).toBe(2);
    expect(state.fingerprints[0].rows[0].id).toBe(o.rows[0].id);
    expect(state.fingerprints[0].rows[0].baselineId).toBe(baseline.id);
  } finally {
    await f.close();
  }
}, 60000);

test("full independent CLI batch scores 100, state stays compact and snapshots survive changes", async () => {
  const f = await fixture(() => ({ text: "37" }));
  try {
    const { object: o, baseline } = await create(f);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(202);
    expect((await f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(409);
    await f.app.idle();
    const state = (await f.api("state")).data,
      summary = state.fingerprintBatches[0];
    expect(summary.score).toBe(100);
    expect(summary.attempted).toBe(50);
    expect(summary.valid).toBe(50);
    expect(summary.raw).toBeUndefined();
    expect(summary.samples).toBeUndefined();
    expect(summary.counts).toBeUndefined();
    expect(state.fingerprintCalls).toEqual({ attempted: 50, success: 50 });
    expect(state.fingerprints[0].enabled).toBe(false);
    expect(f.calls.length).toBe(50);
    for (const call of f.calls) {
      expect(call.messages[0].content).not.toContain("FINAL_ANSWER");
      expect(call.messages[0].content).toContain("355");
    }
    const detail = (await f.api("fingerprint-batches/" + summary.id)).data;
    expect(detail.counts[36]).toBe(50);
    expect(detail.baseline.id).toBe(baseline.id);
    const samples = (await f.api(`fingerprint-batches/${summary.id}/samples`))
      .data;
    expect(samples.total).toBe(50);
    expect(samples.items[0].raw).toBe("37");
    expect(samples.items[0].cli.toolEvents).toBe(0);
    const updated = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...o,
        name: "rename",
        intervalMinutes: 2000,
        rows: [
          ...o.rows,
          { target: "group/reasoning", effort: "low", baselineId: baseline.id },
        ],
      })
    ).data;
    expect((await f.api("state")).data.fingerprints[0].rows[0].historyKey).toBe(
      summary.historyKey,
    );
    const removed = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...updated,
        rows: updated.rows.slice(1),
      })
    ).data;
    const readded = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...removed,
        rows: [...removed.rows, o.rows[0]],
      })
    ).data;
    expect(readded.rows[1].id).not.toBe(o.rows[0].id);
    await f.restart();
    expect((await f.api("fingerprint-batches/" + summary.id)).data).toEqual(
      detail,
    );
    f.setNow(f.now + 6 * 86400000);
    expect((await f.api("state")).data.fingerprintBatches.length).toBe(1);
    f.setNow(f.now + 25 * 86400000);
    expect((await f.api("state")).data.fingerprintBatches.length).toBe(0);
    expect(
      (await f.api(`fingerprint-batches/${summary.id}/samples`)).status,
    ).toBe(404);
    expect((await f.api("baselines/" + baseline.id)).status).toBe(200);
  } finally {
    await f.close();
  }
}, 120000);

test("invalid tools/format and call failures consume budget; 39/40 samples and 80% gate", async () => {
  let i = 0,
    limit = 40;
  const f = await fixture(() => {
    i++;
    return i <= limit
      ? { text: "37" }
      : i <= 44
        ? { text: "37", tools: true }
        : i <= 48
          ? { text: "Answer: 37" }
          : { status: 502 };
  });
  try {
    const { object: o } = await create(f);
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    let state = (await f.api("state")).data;
    expect(state.fingerprintBatches[0].score).toBe(100);
    expect(state.fingerprintBatches[0].success).toBe(48);
    expect(state.fingerprintBatches[0].valid).toBe(40);
    expect(state.fingerprintCalls).toEqual({ attempted: 50, success: 48 });
    const detail = (
      await f.api(
        `fingerprint-batches/${state.fingerprintBatches[0].id}/samples`,
      )
    ).data;
    expect(detail.items[40].invalid).toBe("tools");
    expect(detail.items[44].invalid).toBe("format");
    i = 0;
    await f.api(`objects/${o.id}`, "PUT", { ...o, samples: 51 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    state = (await f.api("state")).data;
    expect(state.fingerprintBatches[1].score).toBeNull();
    expect(state.fingerprintBatches[1].reason).toBe("valid-rate");
    expect(f.calls.length).toBe(101);
    i = 0;
    limit = 39;
    await f.api(`objects/${o.id}`, "PUT", { ...o, samples: 50 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const insufficient = (await f.api("state")).data.fingerprintBatches[2];
    expect(insufficient.score).toBeNull();
    expect(insufficient.reason).toBe("insufficient");
    expect(insufficient.valid).toBe(39);
  } finally {
    await f.close();
  }
}, 180000);

test("sample-boundary fairness, frozen edits, stopping only this card and no phantom model batches", async () => {
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  let first = true;
  const f = await fixture(async (body) => {
    if (body.messages[0].content.includes("355") && first) {
      first = false;
      entered();
      await gate;
    }
    return {
      text: body.messages[0].content.includes("355")
        ? "37"
        : "FINAL_ANSWER: 21",
    };
  });
  try {
    const { object: o, baseline } = await create(f, { samples: 3 });
    const original = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...o,
        rows: [
          ...o.rows,
          { target: "group/reasoning", baselineId: baseline.id, effort: "low" },
        ],
      })
    ).data;
    const legacy = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    await blocked;
    await f.api(`objects/${legacy.id}/run`, "POST", {});
    await f.api(`objects/${o.id}`, "PUT", {
      ...original,
      samples: 7,
      enabled: true,
    });
    await f.api(`objects/${o.id}`, "PUT", {
      ...original,
      samples: 7,
      enabled: false,
    });
    expect((await f.api("state")).data.busy).toContain(o.id);
    release();
    await f.app.idle();
    const state = (await f.api("state")).data;
    expect(f.calls.length).toBe(7);
    expect(f.calls[1].messages[0].content).toContain("FINAL_ANSWER");
    expect(state.fingerprintBatches.map((b: any) => b.attempted)).toEqual([
      3, 3,
    ]);
    expect(state.fingerprintBatches.map((b: any) => b.target)).toEqual([
      "test/model",
      "group/reasoning",
    ]);
    expect(state.fingerprintBatches[0].reason).toBe("insufficient");
    expect(state.fingerprints[0].enabled).toBe(false);
    await f.api(`objects/${o.id}/run`, "POST", {});
    await waitFor(
      f,
      (s) =>
        s.fingerprintBatches.length > 2 &&
        s.fingerprintBatches[2].attempted >= 1,
    );
    await f.api(`objects/${o.id}/stop`, "POST", {});
    await f.app.idle();
    const stopped = (await f.api("state")).data;
    expect(stopped.fingerprintBatches.length).toBe(3);
    expect(stopped.fingerprintBatches[2].reason).toBe("interrupted");
    expect(stopped.fingerprintBatches[2].score).toBeNull();
    await f.api(`objects/${o.id}`, "DELETE");
    expect((await f.api("state")).data.fingerprintBatches).toEqual([]);
    expect((await f.api("baselines/" + baseline.id)).status).toBe(200);
  } finally {
    release();
    await f.close();
  }
}, 60000);

test("API scoring uses frequencies over all 355 numbers, not raw sample counts or mode distance", async () => {
  let alternate = true,
    i = 0;
  const f = await fixture(() => ({
    text: String(alternate && i++ % 2 ? 73 : 37),
  }));
  try {
    const { object: o } = await create(f, { samples: 40 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    expect((await f.api("state")).data.fingerprintBatches[0].score).toBeCloseTo(
      44.2076954715856,
      8,
    );
    alternate = false;
    const different = (await f.api("baselines", "POST", [reference({ 73: 1 })]))
      .data[0];
    await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      rows: [{ ...o.rows[0], baselineId: different.id }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const state = (await f.api("state")).data;
    expect(state.fingerprintBatches[1].score).toBe(0);
    expect(state.fingerprintBatches[0].score).toBeCloseTo(44.2076954715856, 8);
    expect(state.fingerprintBatches[1].historyKey).not.toBe(
      state.fingerprintBatches[0].historyKey,
    );
  } finally {
    await f.close();
  }
}, 120000);

test("new routes retain capability and Origin checks; incomplete CLI outputs remain traceable", async () => {
  const f = await fixture(() => ({ text: "37", finish: "length" }));
  try {
    const { object: o } = await create(f, { samples: 1 });
    for (const [route, method] of [
      ["baselines", "POST"],
      ["baselines", "GET"],
      [`objects/${o.id}/stop`, "POST"],
      ["fingerprint-batches/missing", "GET"],
      ["fingerprint-batches/missing/samples", "GET"],
    ]) {
      expect(
        (
          await fetch(f.app.url + "/api/" + route, {
            method,
            headers: { Origin: "null" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(f.app.url + "/api/" + route, {
            method,
            headers: {
              Origin: "https://evil.example",
              Authorization: "Bearer " + f.app.token,
            },
          })
        ).status,
      ).toBe(403);
    }
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const state = (await f.api("state")).data;
    expect(state.fingerprintBatches[0].reason).toBe("calls-failed");
    expect(state.fingerprintCalls).toEqual({ attempted: 1, success: 0 });
    const samples = (
      await f.api(
        `fingerprint-batches/${state.fingerprintBatches[0].id}/samples`,
      )
    ).data;
    expect(samples.items[0].raw).toBe("37");
    expect(samples.items[0].value).toBeNull();
    expect(samples.items[0].cli.errorKind).toBe("protocol");
  } finally {
    await f.close();
  }
}, 30000);

test("cancel a queued fingerprint without interrupting a different card's active CLI", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const f = await fixture(async () => {
    entered();
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  try {
    const legacy = await f.object(),
      { object: o } = await create(f, { samples: 3 });
    await f.api(`objects/${legacy.id}/run`, "POST", {});
    await ready;
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.api(`objects/${o.id}/stop`, "POST", {});
    const state = (await f.api("state")).data;
    expect(state.running).toBe(legacy.id);
    expect(state.busy).not.toContain(o.id);
    expect(state.fingerprintBatches).toHaveLength(0);
    release();
    await f.app.idle();
    expect((await f.api("state")).data.records[0].call).toBe("success");
    expect(f.calls).toHaveLength(1);
  } finally {
    release();
    await f.close();
  }
}, 30000);

test("deleting an in-flight fingerprint cannot resurrect its samples or batches", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const f = await fixture(async () => {
    entered();
    await gate;
    return { text: "37" };
  });
  try {
    const { object: o, baseline: b } = await create(f, { samples: 3 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await ready;
    await f.api(`objects/${o.id}`, "DELETE");
    release();
    await f.app.idle();
    const state = (await f.api("state")).data;
    expect(state.fingerprints).toHaveLength(0);
    expect(state.fingerprintBatches).toHaveLength(0);
    expect(state.fingerprintCalls).toEqual({ attempted: 0, success: 0 });
    expect((await f.api("baselines/" + b.id)).status).toBe(200);
  } finally {
    release();
    await f.close();
  }
}, 30000);

test("fingerprint schedule starts after round completion, never overlaps or catches up", async () => {
  const f = await fixture(() => ({ text: "37" }));
  try {
    const { object: o } = await create(f, { samples: 1 });
    await f.app.tick();
    expect(f.calls).toHaveLength(0);
    await f.api(`objects/${o.id}`, "PUT", { ...o, enabled: true });
    await f.app.tick();
    await f.app.idle();
    let state = (await f.api("state")).data;
    expect(state.fingerprints[0].nextAt).toBe(f.now + 86400000);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(1);
    f.setNow(f.now + 10 * 86400000);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(2);
    state = (await f.api("state")).data;
    expect(state.fingerprints[0].nextAt).toBe(f.now + 86400000);
  } finally {
    await f.close();
  }
}, 60000);

test("an enabled card with all rows disabled cannot poison the shared scheduler", async () => {
  const f = await fixture();
  try {
    const { object: o } = await create(f);
    await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      enabled: true,
      rows: o.rows.map((r: any) => ({ ...r, enabled: false })),
    });
    await f.app.tick();
    await f.app.idle();
    expect((await f.api("state")).data.error).toBeNull();
    expect(f.calls).toHaveLength(0);
    const legacy = await f.object();
    expect((await f.api(`objects/${legacy.id}/run`, "POST", {})).status).toBe(
      202,
    );
    await f.app.idle();
    expect((await f.api("state")).data.records[0].call).toBe("success");
  } finally {
    await f.close();
  }
}, 30000);

test("enabling a previously tested card and changing its interval both use the last round end", async () => {
  const f = await fixture(() => ({ text: "37" }));
  try {
    const { object: o } = await create(f, { samples: 1 });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const finished = f.now;
    f.setNow(f.now + 3600000);
    const current = (await f.api("state")).data.fingerprints[0];
    const enabled = (
      await f.api(`objects/${o.id}`, "PUT", { ...current, enabled: true })
    ).data;
    expect(enabled.nextAt).toBe(finished + 86400000);
    const shorter = (
      await f.api(`objects/${o.id}`, "PUT", {
        ...enabled,
        intervalMinutes: 120,
      })
    ).data;
    expect(shorter.nextAt).toBe(finished + 7200000);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(1);
    f.setNow(shorter.nextAt);
    await f.app.tick();
    await f.app.idle();
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 30000);

test("restart interrupts a running fingerprint round without creating batches for unstarted models", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (entered = r));
  const f = await fixture(async () => {
    entered();
    await gate;
    return { text: "37" };
  });
  try {
    const { object: o, baseline: b } = await create(f, { samples: 3 });
    await f.api(`objects/${o.id}`, "PUT", {
      ...o,
      enabled: true,
      rows: [...o.rows, { target: "group/reasoning", baselineId: b.id }],
    });
    await f.app.tick();
    await ready;
    await f.restart();
    release();
    const state = (await f.api("state")).data;
    expect(state.fingerprintBatches).toHaveLength(1);
    expect(state.fingerprintBatches[0].reason).toBe("interrupted");
    expect(state.fingerprintBatches[0].score).toBeNull();
    expect(state.fingerprints[0].nextAt).toBe(f.now + 86400000);
    expect(state.busy).toHaveLength(0);
  } finally {
    release();
    await f.close();
  }
}, 30000);
