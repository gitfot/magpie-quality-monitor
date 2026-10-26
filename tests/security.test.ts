import { test, expect } from "bun:test";
import http from "node:http";
import { fixture } from "./fixture.ts";
import { startMonitor } from "../src/service.ts";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("simultaneous cross-process startup recovers stale metadata with only one active API owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "monitor-race-"));
  mkdirSync(join(directory, "owner"));
  writeFileSync(
    join(directory, "owner", "owner.json"),
    JSON.stringify({ pid: 99999999, url: "http://127.0.0.1:1", token: "dead" }),
  );
  const children = Array.from({ length: 2 }, () =>
    Bun.spawn([process.execPath, join(import.meta.dir, "host.ts"), directory], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const readers = children.map((c) => c.stdout.getReader());
  try {
    for (const reader of readers)
      expect(new TextDecoder().decode((await reader.read()).value)).toContain(
        "waiting",
      );
    writeFileSync(join(directory, "start"), "");
    const owners = [];
    for (const reader of readers) {
      let text = "";
      while (!text.includes("\n"))
        text += new TextDecoder().decode((await reader.read()).value);
      owners.push(JSON.parse(text));
    }
    const statuses = await Promise.all(
      owners.map(async (o) => {
        try {
          return (
            await fetch(o.url + "/api/state", {
              headers: { Authorization: "Bearer " + o.token },
            })
          ).status;
        } catch {
          return 0;
        }
      }),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  } finally {
    for (const child of children) {
      child.stdin.write("close\n");
      child.stdin.end();
    }
    for (const child of children) {
      await child.exited;
      expect(await new Response(child.stderr).text()).not.toContain(
        "MaxListeners",
      );
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a late transient host does not retire a monitor belonging to another live parent", async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, "owner", "owner.json");
    const owner = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...owner, parentPid: process.pid }));
    await expect(
      startMonitor({
        directory: f.directory,
        timers: false,
        respectOtherParents: true,
      }),
    ).rejects.toThrow("already owns");
    expect((await f.api("state")).status).toBe(200);
  } finally {
    await f.close();
  }
});

test("handover interrupts an in-flight request and saves its old snapshot before successor reads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = await fixture(async () => {
    await gate;
    return { text: "FINAL_ANSWER: 21" };
  });
  let next: Awaited<ReturnType<typeof startMonitor>> | undefined;
  try {
    const o = await f.object();
    await f.api(`objects/${o.id}/run`, "POST", {});
    while (!f.calls.length) await Bun.sleep(1);
    next = await startMonitor({ directory: f.directory, timers: false });
    const state = await (
      await fetch(next.url + "/api/state", {
        headers: { Authorization: "Bearer " + next.token },
      })
    ).json();
    expect(state.records).toHaveLength(1);
    expect(state.records[0].call).toBe("interrupted");
    expect(f.calls).toHaveLength(1);
  } finally {
    release();
    await next?.close();
    await f.close();
  }
});

test("opaque origin never substitutes for authorization on reads or mutations", async () => {
  const f = await fixture();
  try {
    for (const route of [
      "/api/state",
      "/api/export",
      "/api/objects",
      "/api/retire",
    ]) {
      const method =
        route === "/api/objects" || route === "/api/retire" ? "POST" : "GET";
      expect(
        (
          await fetch(f.app.url + route, {
            method,
            headers: { Origin: "null" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(f.app.url + route, {
            method,
            headers: { Origin: "null", Authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(f.app.url + route, {
            method,
            headers: {
              Origin: "https://evil.example",
              Authorization: "Bearer " + f.app.token,
            },
          })
        ).status,
      ).toBe(403);
    }
    const badHost = await new Promise<number>((resolve) => {
      http.get(
        f.app.url + "/api/state",
        {
          headers: {
            Host: "rebind.example",
            Authorization: "Bearer " + f.app.token,
          },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode!);
        },
      );
    });
    expect(badHost).toBe(403);
    const allowed = await fetch(f.app.url + "/api/state", {
      headers: { Origin: "null", Authorization: "Bearer " + f.app.token },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("null");
  } finally {
    await f.close();
  }
});

test("successor drains the old host before taking ownership and preserves history", async () => {
  const f = await fixture();
  let next: Awaited<ReturnType<typeof startMonitor>> | null = null;
  try {
    const o = await f.object();
    await f.api("objects/" + o.id + "/run", "POST", {});
    await f.app.idle();
    next = await startMonitor({ directory: f.directory, timers: false });
    const r = await fetch(next.url + "/api/state", {
      headers: { Authorization: "Bearer " + next.token },
    });
    const state = await r.json();
    expect(state.objects).toHaveLength(1);
    expect(state.records).toHaveLength(1);
    await expect(f.api("state")).rejects.toThrow();
  } finally {
    await next?.close();
    await f.close();
  }
});

test("invalid settings and malformed objects do not erase saved configuration", async () => {
  const f = await fixture();
  try {
    const o = await f.object();
    expect(
      (
        await f.api("objects/" + o.id, "PUT", {
          ...o,
          tests: [
            { kind: "logic", name: "No answer", prompt: "Solve", answers: [] },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await f.api("settings", "PUT", { retentionDays: 0 })).status).toBe(
      400,
    );
    const state = (await f.api("state")).data;
    expect(state.objects[0].tests[0].name).toBe("Logic");
    expect(state.settings.retentionDays).toBe(5);
  } finally {
    await f.close();
  }
});
