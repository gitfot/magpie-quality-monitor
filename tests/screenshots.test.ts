import { test, expect } from "bun:test";
import { fixture } from "./fixture.ts";
import http from "node:http";

test("headless screenshots capture the document below the viewport, persist outside history, and require authorization", async () => {
  const f = await fixture(() => ({
    text: '<html><body style="margin:0"><div style="height:1800px;background:linear-gradient(#db694a,#286a82);color:white;font:64px serif">TOP<div style="padding-top:1500px">BOTTOM</div></div></body></html>',
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Long page", prompt: "Draw" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const s = (await f.api("state")).data;
    const id = s.records[0].id;
    const before = (await f.api(`records/${id}`)).data;
    const a = await f.api(`thumbnail/${id}`);
    expect(a.status).toBe(200);
    expect(a.data.error).toBeUndefined();
    expect(a.data.width).toBe(1280);
    expect(a.data.height).toBe(1800);
    expect(a.data.clipped).toBe(false);
    expect(a.data.dataURL).toStartWith("data:image/png;base64,iVBOR");
    const png = Buffer.from(a.data.dataURL.split(",")[1], "base64");
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(1800);
    expect((await fetch(f.app.url + `/api/thumbnail/${id}`)).status).toBe(401);
    expect(
      (
        await fetch(f.app.url + `/api/thumbnail/${id}`, {
          headers: {
            Authorization: `Bearer ${f.app.token}`,
            Origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
    expect(JSON.stringify((await f.api("state")).data)).not.toContain(
      "data:image/png",
    );
    expect(JSON.stringify((await f.api("export")).data)).not.toContain(
      "data:image/png",
    );
    await f.restart();
    expect((await f.api(`thumbnail/${id}`)).data).toEqual(a.data);
    expect((await f.api(`records/${id}`)).data).toEqual(before);
    expect(f.calls).toHaveLength(1);
    await f.api(`objects/${o.id}`, "DELETE");
    expect((await f.api(`thumbnail/${id}`)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 30000);

test("oversized drawings are bounded and visibly marked as clipped", async () => {
  const f = await fixture(() => ({
    text: '<html><body style="margin:0;width:3000px;height:12000px;background:#abc">Large</body></html>',
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Large", prompt: "Draw" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const id = (await f.api("state")).data.records[0].id;
    const a = (await f.api(`thumbnail/${id}`)).data;
    expect(a.error).toBeUndefined();
    expect(a.clipped).toBe(true);
    expect(a.width).toBeLessThanOrEqual(2048);
    expect(a.width * a.height).toBeLessThanOrEqual(8000000);
    const png = Buffer.from(a.dataURL.split(",")[1], "base64");
    expect(png.readUInt32BE(16)).toBe(a.width);
    expect(png.readUInt32BE(20)).toBe(a.height);
  } finally {
    await f.close();
  }
}, 30000);

test("screenshot rendering cannot execute model scripts or reach local/external resources", async () => {
  let hits = 0;
  const trap = http.createServer((_req, res) => {
    hits++;
    res.end("forbidden");
  });
  await new Promise<void>((r) => trap.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(trap.address() as { port: number }).port}/forbidden`;
  const f = await fixture(() => ({
    text: `<html><head><style>@import url('${url}');body{background-image:url('${url}');height:1000px}</style></head><body onload="fetch('${url}')"><script>fetch('${url}')</script><iframe src="${url}"></iframe><svg><use href="${url}#x"/></svg>Safe visible content</body></html>`,
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Hostile", prompt: "Draw" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const id = (await f.api("state")).data.records[0].id;
    expect((await f.api(`thumbnail/${id}`)).data.dataURL).toStartWith(
      "data:image/png;base64,",
    );
    expect(hits).toBe(0);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
    trap.closeAllConnections();
    await new Promise<void>((r) => trap.close(() => r()));
  }
}, 30000);

test("deleting an object while screenshots are queued cannot resurrect its records", async () => {
  const f = await fixture(() => ({
    text: '<html><body style="height:1800px">Queued artwork</body></html>',
  }));
  try {
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Queued", prompt: "Draw" }],
    });
    for (let i = 0; i < 4; i++) {
      await f.api(`objects/${o.id}/run`, "POST", {});
      await f.app.idle();
    }
    const rows = (await f.api("state")).data.records;
    const pending = rows.map((r: any) => f.api(`thumbnail/${r.id}`));
    await f.api(`objects/${o.id}`, "DELETE");
    const results = await Promise.all(pending);
    expect(results.every((r: any) => r.status === 404)).toBe(true);
    await f.restart();
    expect((await f.api("export")).data.records).toHaveLength(0);
    expect((await f.api("state")).data.objects).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 30000);

test("a missing screenshot browser does not change drawing success and can be explicitly retried", async () => {
  const f = await fixture(() => ({
    text: '<html><body><svg width="100" height="100"><circle r="20" cx="50" cy="50"/></svg></body></html>',
  }));
  try {
    expect(
      (
        await f.api("settings", "PUT", {
          retentionDays: 5,
          browserPath: "not an absolute path",
        })
      ).status,
    ).toBe(400);
    await f.api("settings", "PUT", {
      retentionDays: 5,
      browserPath: "C:\\nonexistent-quality-browser\\chrome.exe",
    });
    const o = await f.object({
      tests: [{ kind: "drawing", name: "Bird", prompt: "Draw" }],
    });
    await f.api(`objects/${o.id}/run`, "POST", {});
    await f.app.idle();
    const id = (await f.api("state")).data.records[0].id;
    const a = (await f.api(`thumbnail/${id}`)).data;
    expect(a.error).toBe("browser");
    expect(a.dataURL).toBeUndefined();
    const r = (await f.api(`records/${id}`)).data;
    expect(r.call).toBe("success");
    expect(r.artifact).toContain("<svg");
    expect((await f.api(`preview/${id}`)).data.html).toContain("<svg");
    await f.api("settings", "PUT", { retentionDays: 5, browserPath: "" });
    expect(
      (await f.api(`thumbnail/${id}`, "POST", {})).data.dataURL,
    ).toStartWith("data:image/png;base64,");
    expect((await f.api(`records/${id}`)).data).toEqual(r);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30000);
