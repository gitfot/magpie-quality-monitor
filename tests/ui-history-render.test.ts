import { test, expect } from "bun:test";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { embedded } from "./browser.ts";
import { cliFixture } from "./codex-fixture.ts";

test("adding or deleting sibling questions keeps unchanged question statistics and timeline history", async () => {
  const b = await embedded();
  try {
    const o = await b.f.object({
      tests: [
        { kind: "logic", name: "Candy", prompt: "Candy", answers: ["21"] },
        {
          kind: "logic",
          name: "Knowledge",
          prompt: "Knowledge",
          answers: ["21"],
        },
      ],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    const before = (await b.f.api("export")).data.records;
    await b.page.reload();
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await b.ui
      .locator(".testrow")
      .nth(1)
      .getByRole("button", { name: "移除此项", exact: true })
      .click();
    await b.ui.getByRole("button", { name: "保存配置", exact: true }).click();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    await b.ui.locator(".logicitem").nth(1).waitFor({ state: "detached" });
    expect(await b.ui.locator(".logicitem").innerText()).toContain(
      "答案正确 1/1",
    );
    let current = (await b.f.api("state")).data.objects[0];
    await b.f.api(`objects/${o.id}`, "PUT", {
      ...current,
      tests: [
        ...current.tests,
        { kind: "logic", name: "New question", prompt: "New", answers: ["21"] },
      ],
    });
    await b.page.reload();
    expect(await b.ui.locator(".logicitem").first().innerText()).toContain(
      "答案正确 1/1",
    );
    expect(await b.ui.locator(".logicitem").nth(1).innerText()).toContain(
      "答案正确 0/0",
    );
    await b.ui.locator(".logicitem").first().locator(".bars button").click();
    await b.ui.locator("#dialog .readonly").waitFor();
    expect(await b.ui.locator("#dialog .readonly").innerText()).toContain("v1");
    await b.ui.locator("#dialog .close").click();
    current = (await b.f.api("state")).data.objects[0];
    await b.f.api(`objects/${o.id}`, "PUT", {
      ...current,
      tests: current.tests.map((t: any, i: number) =>
        i ? t : { ...t, answers: ["22"] },
      ),
    });
    await b.page.reload();
    expect(await b.ui.locator(".logicitem").first().innerText()).toContain(
      "答案正确 1/1",
    );
    expect(await b.ui.locator(".logicitem").first().innerText()).toContain(
      "跨配置统计",
    );
    await b.ui.getByRole("button", { name: "全部配置", exact: true }).click();
    expect(await b.ui.locator(".logicitem").first().innerText()).toContain(
      "答案正确 0/0",
    );
    expect((await b.f.api("export")).data.records).toEqual(before);
  } finally {
    await b.close();
  }
}, 30000);

test("overview combines backend call success without merging per-object test statistics", async () => {
  let fail = false;
  const b = await embedded(() =>
    fail ? { status: 502 } : { text: "FINAL_ANSWER: 21" },
  );
  const cli = await cliFixture();
  try {
    await b.f.api("settings", "PUT", {
      retentionDays: 5,
      codexPath: (await b.f.api("state")).data.settings.codexPath,
    });
    const direct = await b.f.object();
    const agent = await b.f.object({ name: "CLI", backend: "codex-cli" });
    for (const o of [direct, agent]) {
      await b.f.api(`objects/${o.id}/run`, "POST", {});
      await b.f.app.idle();
    }
    fail = true;
    await b.f.api(`objects/${direct.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.page.reload();
    const metric = b.ui.locator(".metric").nth(2);
    await metric.waitFor();
    expect(await metric.innerText()).toContain("66.7%");
    expect(await metric.innerText()).toContain("2/3");
    expect(await metric.innerText()).not.toContain("codex-cli:");
    expect(await metric.innerText()).not.toContain("direct-gateway:");
    expect(await b.ui.locator(".card").count()).toBe(2);
  } finally {
    await b.close();
    await cli.close();
  }
}, 30000);

test("the synthetic entry animation is visible in cached thumbnails and drawing columns stay narrow", async () => {
  const html = readFileSync(
    join(import.meta.dir, "fixtures/synthetic-entry-animation.html"),
    "utf8",
  );
  const b = await embedded((body) => ({
    text: body.messages[0].content.startsWith("Draw")
      ? html
      : "FINAL_ANSWER: 21",
  }));
  try {
    const o = await b.f.object({
      tests: [
        { kind: "logic", name: "Candy", prompt: "Solve", answers: ["21"] },
        { kind: "drawing", name: "Synthetic artwork", prompt: "Draw" },
      ],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.page.setViewportSize({ width: 2000, height: 1100 });
    await b.page.reload();
    const image = b.ui.locator(".card img.thumbnail");
    await image.waitFor({ timeout: 15000 });
    const src = await image.getAttribute("src");
    const dark = await b.page.evaluate(async (src) => {
      const image = new Image();
      image.src = src!;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i] < 100 && data[i + 1] < 140 && data[i + 2] < 140) count++;
      return count;
    }, src);
    expect(dark).toBeGreaterThan(6000);
    expect(
      (await b.ui.locator(".card .artstage").boundingBox())!.width,
    ).toBeLessThanOrEqual(340);
    expect((await b.ui.locator(".card .artstage").boundingBox())!.height).toBe(
      180,
    );
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/history-render-fixed.png",
    });
    await b.page.setViewportSize({ width: 360, height: 900 });
    expect(
      await b.ui
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    expect(
      (await b.ui.locator(".card .artstage").boundingBox())!.width,
    ).toBeLessThanOrEqual(320);
  } finally {
    await b.close();
  }
}, 30000);
