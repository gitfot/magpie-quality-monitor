import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright";
import { Store } from "../src/store.ts";
import { embedded } from "./browser.ts";

async function heatmap(line: Locator) {
  await line.waitFor();
  const layout = await line.evaluate(async (el) => {
    const deadline = performance.now() + 5000;
    while (true) {
      const rect = el.getBoundingClientRect();
      const nodes = [...el.children].map((node) => {
        const box = node.getBoundingClientRect();
        return {
          id: (node as HTMLElement).dataset.id ?? null,
          action: (node as HTMLElement).dataset.action ?? null,
          text: node.textContent,
          tag: node.tagName,
          title: node.getAttribute("title"),
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          right: box.right,
          background: getComputedStyle(node).backgroundColor,
        };
      });
      const capacity = Math.floor((rect.width + 3) / 21);
      if (
        (nodes.length === capacity &&
          nodes.every((n) => n.width === 18 && n.height === 18)) ||
        performance.now() > deadline
      )
        return {
          capacity,
          viewport: innerWidth,
          width: rect.width,
          right: rect.right,
          nodes,
          overflow: el.scrollWidth > el.clientWidth,
        };
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
  });
  expect(layout.nodes).toHaveLength(layout.capacity);
  expect(layout.capacity).toBeGreaterThan(0);
  for (const node of layout.nodes) {
    expect(node.width).toBe(18);
    expect(node.height).toBe(18);
    expect(node.y).toBe(layout.nodes[0]!.y);
    expect(node.text).toBe("");
  }
  expect(Math.abs(layout.nodes.at(-1)!.right - layout.right)).toBeLessThan(1);
  expect(layout.overflow).toBe(false);
  return layout;
}

test("each execution has one right-aligned square even across downtime and nearby manual runs", async () => {
  const b = await embedded();
  try {
    const o = await b.f.object();
    await b.page.reload();
    await b.ui.getByText("所选范围暂无记录", { exact: true }).waitFor();
    const empty = await heatmap(b.ui.locator(".bars"));
    expect(
      empty.nodes.every(
        (n) => n.tag === "SPAN" && n.id === null && n.action === null,
      ),
    ).toBe(true);
    expect(empty.nodes[0]!.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(await b.ui.locator(".axis").innerText()).toContain(
      "展示最近 0 条 / 共 0 条",
    );
    const start = b.f.now;
    for (const minutes of [0, 30, 510, 540, 542]) {
      b.f.setNow(start + minutes * 60000);
      expect((await b.f.api(`objects/${o.id}/run`, "POST", {})).status).toBe(
        202,
      );
      await b.f.app.idle();
    }
    const records = (await b.f.api("export")).data.records;
    await b.page.reload();
    const layout = await heatmap(b.ui.locator(".bars"));
    const nodes = b.ui.locator(".bars button");
    expect(layout.nodes.slice(-5).map((n) => n.id)).toEqual(
      records.toReversed().map((r: any) => r.id),
    );
    expect(
      layout.nodes.slice(0, -5).every((n) => n.id === null && n.tag === "SPAN"),
    ).toBe(true);
    expect(
      layout.nodes
        .slice(-5)
        .every((n) => n.background !== layout.nodes[0]!.background),
    ).toBe(true);
    for (let i = 0; i < records.length; i++) {
      const r = records.toReversed()[i];
      const stamp = await nodes.nth(i).evaluate(
        (_el, at) =>
          new Date(at).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }),
        r.at,
      );
      expect(await nodes.nth(i).getAttribute("title")).toContain(stamp);
      expect(await nodes.nth(i).getAttribute("title")).toContain("答案正确");
      expect(await nodes.nth(i).getAttribute("aria-label")).toContain("v1");
    }
    await nodes.last().click();
    await b.ui.locator("#overlay.open").waitFor();
    expect(await b.ui.locator("#dialog").innerText()).toContain(
      "历史快照 · 只读",
    );
    expect(await b.ui.locator("#dialog pre").first().innerText()).toContain(
      records[0].request.stdin,
    );
    expect(await b.ui.locator(".historyrecord").count()).toBe(0);
    await b.ui.locator("#dialog .close").click();
    await b.ui.getByRole("button", { name: "历史", exact: true }).click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(records.length);
  } finally {
    await b.close();
  }
}, 30000);

test("heatmap capacity follows the logic column width while statistics keep the full selected range", async () => {
  const b = await embedded();
  const pageErrors: string[] = [];
  b.page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const o = await b.f.object({
      tests: [
        { name: "Logic", kind: "logic", prompt: "Solve", answers: ["21"] },
        { name: "Drawing", kind: "drawing", prompt: "Draw", enabled: false },
      ],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    const original = (await b.f.api("export")).data.records[0];
    const store = new Store(b.f.directory);
    try {
      for (let i = 1; i < 100; i++) {
        const at = original.at + i * 60000;
        store.add({
          ...original,
          id: `sequence-${i}`,
          at,
          finishedAt: at + 1000,
          call: i === 96 ? "timeout" : "success",
          verdict:
            i === 96
              ? null
              : i === 80
                ? "incorrect"
                : i === 90
                  ? "format"
                  : "correct",
        });
      }
      store.add({
        ...original,
        id: "outside-day",
        at: original.at - 2 * 86400000,
        finishedAt: original.at - 2 * 86400000 + 1000,
      });
      store.add({
        ...original,
        id: "hidden-failure",
        at: original.at - 60000,
        finishedAt: original.at - 59000,
        verdict: "incorrect",
      });
    } finally {
      store.close();
    }
    b.f.setNow(original.at + 2 * 3600000);
    const noArt = await b.f.object({ name: "No drawing column" });
    await b.page.reload();
    const state = (await b.f.api("state")).data;
    const day = state.records.filter(
      (r: any) => r.objectId === o.id && r.at >= b.f.now - 86400000,
    );
    const capacities = new Map<number, number>();
    for (const width of [2000, 1280, 940, 900, 646, 360, 1280]) {
      await b.page.setViewportSize({ width, height: 900 });
      const layout = await heatmap(b.ui.locator(".bars").first());
      capacities.set(width, layout.capacity);
      expect(layout.nodes.map((n) => n.id)).toEqual(
        day
          .slice(0, layout.capacity)
          .reverse()
          .map((r: any) => r.id),
      );
      expect(await b.ui.locator(".axis").first().innerText()).toContain(
        `展示最近 ${layout.capacity} 条 / 共 101 条`,
      );
      expect(await b.ui.locator(".logicstats").first().innerText()).toContain(
        "答案正确 97/99",
      );
      expect(await b.ui.locator(".logicstats").first().innerText()).toContain(
        "调用成功 100/101",
      );
      expect(
        await b.ui
          .locator("body")
          .evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
      ).toBe(true);
      const empty = await heatmap(b.ui.locator(".bars").nth(1));
      if (layout.viewport > 900)
        expect(empty.capacity).toBeGreaterThan(layout.capacity);
    }
    expect(capacities.get(2000)!).toBeGreaterThan(capacities.get(1280)!);
    expect(capacities.get(900)!).toBeGreaterThan(capacities.get(940)!);
    expect(capacities.get(360)!).toBeLessThan(capacities.get(1280)!);
    const green = await b.ui
      .locator(".bars .state-correct")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const red = await b.ui
      .locator(".bars .state-incorrect")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const amber = await b.ui
      .locator(".bars .state-format")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(red).not.toBe(green);
    expect(amber).not.toBe(red);
    expect(
      await b.ui
        .locator(".bars .state-timeout")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe(amber);
    const shown = (await heatmap(b.ui.locator(".bars").first())).capacity;
    for (const [lang, text] of [
      ["en", `Showing latest ${shown} records / Total 101 records`],
      ["zh-TW", `顯示最近 ${shown} 筆 / 共 101 筆`],
      ["ja", `直近 ${shown} 件 / 合計 101 件`],
      ["de", `Neueste ${shown} Einträge / Insgesamt 101 Einträge`],
    ]) {
      await b.page
        .locator("#monitor")
        .evaluate(
          (el, lang) =>
            (el as HTMLIFrameElement).contentWindow!.postMessage(
              { magpie: 1, event: "theme", data: { lang } },
              "*",
            ),
          lang,
        );
      await b.ui.locator(".axis").first().filter({ hasText: text }).waitFor();
    }
    await b.page
      .locator("#monitor")
      .evaluate((el) =>
        (el as HTMLIFrameElement).contentWindow!.postMessage(
          { magpie: 1, event: "theme", data: { lang: "zh" } },
          "*",
        ),
      );
    await b.ui.getByRole("button", { name: "最近 7 天", exact: true }).click();
    expect(await b.ui.locator(".axis").first().innerText()).toContain(
      `展示最近 ${shown} 条 / 共 102 条`,
    );
    expect(
      (await b.f.api("state")).data.objects.some((o: any) => o.id === noArt.id),
    ).toBe(true);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/heatmap-dense-desktop.png",
    });
    await b.page.setViewportSize({ width: 360, height: 900 });
    await heatmap(b.ui.locator(".bars").first());
    await b.page.screenshot({
      path: ".test-artifacts/heatmap-dense-mobile.png",
    });
    expect(pageErrors).toEqual([]);
  } finally {
    await b.close();
  }
}, 30000);

test("twelve records sit after empty squares and resizing leaves an editor draft and focus intact", async () => {
  const b = await embedded();
  try {
    const o = await b.f.object();
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    const original = (await b.f.api("export")).data.records[0];
    const store = new Store(b.f.directory);
    try {
      for (let i = 1; i < 12; i++)
        store.add({
          ...original,
          id: `sparse-${i}`,
          at: original.at - i * 60000,
          finishedAt: original.at - i * 60000 + 1000,
        });
    } finally {
      store.close();
    }
    await b.page.reload();
    let layout = await heatmap(b.ui.locator(".bars"));
    expect(layout.nodes.filter((n) => n.id)).toHaveLength(12);
    expect(
      layout.nodes
        .slice(0, -12)
        .every(
          (n) =>
            n.tag === "SPAN" && n.action === null && n.title === "暂无执行记录",
        ),
    ).toBe(true);
    expect(layout.nodes.slice(-12).every((n) => n.tag === "BUTTON")).toBe(true);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/heatmap-sparse-desktop.png",
    });
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    const input = b.ui.locator('[name="objectName"]');
    await input.fill("Draft survives resizing");
    const handle = await input.elementHandle();
    await b.page.setViewportSize({ width: 360, height: 900 });
    layout = await heatmap(b.ui.locator(".bars"));
    expect(layout.nodes.filter((n) => n.id)).toHaveLength(
      Math.min(12, layout.capacity),
    );
    expect(await input.inputValue()).toBe("Draft survives resizing");
    expect(
      await handle!.evaluate(
        (el) => el.isConnected && document.activeElement === el,
      ),
    ).toBe(true);
    await b.ui.locator("#dialog .close").click();
    await heatmap(b.ui.locator(".bars"));
    await b.page.screenshot({
      path: ".test-artifacts/heatmap-sparse-mobile.png",
    });
  } finally {
    await b.close();
  }
}, 30000);

test("disabled logic and drawing tests can run once without enabling them or showing card event notes", async () => {
  const b = await embedded();
  try {
    const o = await b.f.object({
      tests: [
        {
          kind: "logic",
          name: "Disabled logic",
          prompt: "Solve",
          answers: ["21"],
          enabled: false,
        },
        {
          kind: "drawing",
          name: "Disabled drawing",
          prompt: "Draw",
          enabled: false,
        },
      ],
    });
    await b.page.reload();
    const stateBefore = (await b.f.api("state")).data.objects[0];
    for (const selector of [".logicitem", ".drawing-tests"]) {
      const run = b.ui.locator(selector).locator('[data-action="run"]:enabled');
      await run.waitFor();
      expect(await run.isEnabled()).toBe(true);
      const response = b.page.waitForResponse(
        (r) =>
          r.url().endsWith(`/objects/${o.id}/run`) &&
          r.request().method() === "POST",
      );
      await run.click();
      expect((await response).status()).toBe(202);
      await b.f.app.idle();
    }
    expect((await b.f.api("export")).data.records).toHaveLength(2);
    expect((await b.f.api("state")).data.objects[0]).toEqual(stateBefore);
    const store = new Store(b.f.directory);
    try {
      store.event({
        id: "gap",
        objectId: o.id,
        at: b.f.now,
        type: "gap",
        message: "监测空档；错过的轮次不补跑",
      });
      store.event({
        id: "skip",
        objectId: o.id,
        at: b.f.now,
        type: "skipped",
        message: "上轮未完成，跳过本轮",
      });
    } finally {
      store.close();
    }
    await b.page.reload();
    await b.ui.locator(".card").waitFor();
    expect(await b.ui.locator(".card").innerText()).not.toContain("监测空档");
    expect(await b.ui.locator(".card").innerText()).not.toContain("上轮未完成");
    expect((await b.f.api("export")).data.events).toHaveLength(2);
    b.f.access.magpiePath = join(b.f.directory, "missing.exe");
    await b.f.api("catalog");
    await b.page.reload();
    await b.ui.locator(".connection.warning").waitFor();
    expect(
      await b.ui.locator('.logicitem [data-action="run"]').isDisabled(),
    ).toBe(false);
    expect(
      await b.ui.locator('.drawing-tests [data-action="run"]').isDisabled(),
    ).toBe(false);
  } finally {
    await b.close();
  }
}, 30000);
