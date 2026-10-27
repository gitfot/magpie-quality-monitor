import { test, expect } from "bun:test";
import { embedded } from "./browser.ts";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../src/store.ts";

const baseline = (value = 37, name = "Synthetic reference") => ({
  name,
  model: "synthetic/reference",
  iterations: 100,
  distribution: Array.from({ length: 355 }, (_, i) =>
    i === value - 1 ? 1 : 0,
  ),
});

test("both monitor types share responsive cells, footers and actions without filtering fingerprint overview history", async () => {
  const b = await embedded((body) => ({
    text: body.messages[0].content.includes("355") ? "37" : "FINAL_ANSWER: 21",
  }));
  try {
    expect(
      (
        await b.f.api("settings", "PUT", {
          retentionDays: 5,
          fingerprintRetentionDays: 365,
        })
      ).status,
    ).toBe(200);
    const legacy = await b.f.object({ name: "Shared legacy card" });
    await b.f.api(`objects/${legacy.id}/run`, "POST", {});
    const reference = (await b.f.api("baselines", "POST", [baseline()]))
      .data[0];
    const card = (
      await b.f.api("objects", "POST", {
        type: "fingerprint",
        name: "Shared fingerprint card",
        samples: 1,
        rows: ["Dense", "Older than 30 days", "Empty"].map((name) => ({
          name,
          target: "test/model",
          baselineId: reference.id,
        })),
      })
    ).data;
    await b.f.api(`objects/${card.id}/run`, "POST", { rowId: card.rows[0].id });
    await b.f.app.idle();
    const store = new Store(b.f.directory, b.f.now);
    try {
      const original = store.fingerprint.batches()[0]!;
      for (let i = 1; i < 100; i++) {
        const at = b.f.now + i * 60000;
        store.fingerprint.saveBatch({
          ...original,
          id: `shared-batch-${i}`,
          at,
          finishedAt: at + 1000,
          historyKey: i === 97 ? "previous-config" : original.historyKey,
          score: 97,
          reason: null,
        });
      }
      store.fingerprint.saveBatch({
        ...original,
        id: "older-batch",
        rowId: card.rows[1].id,
        row: card.rows[1],
        historyKey: card.rows[1].historyKey,
        at: b.f.now - 40 * 86400000,
        finishedAt: b.f.now - 40 * 86400000 + 1000,
      });
    } finally {
      store.close();
    }
    b.f.setNow(b.f.now + 100 * 60000);
    await b.page.reload();
    await b.ui.locator(".card-actions").nth(1).waitFor();
    expect(await b.ui.locator(".fp-card").innerText()).not.toContain(
      "固定参考基准",
    );
    expect(await b.ui.locator(".fp-row .mono").first().innerText()).toBe(
      "test/model",
    );
    expect(
      await b.ui
        .locator(
          ".fp-card select, .fp-card .fp-filters, .fp-meta, .fp-timeline",
        )
        .count(),
    ).toBe(0);
    const buttons = await b.ui
      .locator(".card-actions")
      .evaluateAll((bars) =>
        bars.map((bar) =>
          [...bar.querySelectorAll("button")].map((b) => b.textContent),
        ),
      );
    expect(buttons[0]).toEqual(buttons[1]);
    expect(buttons[0]).toEqual(["历史", "启用", "编辑", "▷ 执行一轮"]);
    expect(await b.ui.locator(".cardhead .status").allTextContents()).toEqual([
      "已暂停",
      "已暂停",
    ]);
    expect(
      await b.ui.locator('.logicitem [data-action="run"]').innerText(),
    ).toBe("▷ 运行");
    expect(
      await b.ui.locator('.fp-row [data-action="fp-run"]').first().innerText(),
    ).toBe("▷ 运行");
    expect(
      await b.ui.locator(".fp-row").nth(1).locator(".fp-result").innerText(),
    ).toContain("未评分");
    await b.ui.locator(".bars .state-correct").waitFor();
    await b.ui.locator('.bars .fp-cell[data-level="5"]').first().waitFor();
    for (const dark of [false, true, false]) {
      await b.page
        .locator("#monitor")
        .evaluate(
          (el, dark) =>
            (el as HTMLIFrameElement).contentWindow!.postMessage(
              { magpie: 1, event: "theme", data: { lang: "zh", dark } },
              "*",
            ),
          dark,
        );
      await b.ui
        .locator(`html[data-theme="${dark ? "dark" : "light"}"]`)
        .waitFor();
      await b.ui.locator(".bars").evaluateAll(async (lines) => {
        await Promise.all(
          lines
            .flatMap((line) => line.getAnimations({ subtree: true }))
            .map((animation) => animation.finished.catch(() => {})),
        );
      });
      const palette = await b.ui.locator(".fp-legend").evaluate((legend) => {
        const color = (el: Element) => getComputedStyle(el).backgroundColor,
          canvas = document.createElement("canvas"),
          context = canvas.getContext("2d")!;
        canvas.width = canvas.height = 1;
        const rgb = (value: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
        };
        const base = rgb(color(document.querySelector(".card")!)),
          correct = rgb(color(document.querySelector(".state-correct")!)),
          red = rgb(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--red",
            ),
          ),
          mix = (foreground: number[], weight: number) =>
            foreground.map((n, i) =>
              Math.round(n * weight + base[i]! * (1 - weight)),
            ),
          levels = [...legend.querySelectorAll("[data-level]")].map(color);
        return {
          levels,
          samples: levels.map(rgb),
          expected: [
            mix(red, 0.75),
            mix(red, 0.5),
            mix(red, 0.25),
            mix(correct, 0.7),
            correct,
          ],
          scored: color(
            document.querySelector('.bars .fp-cell[data-level="5"]')!,
          ),
          empty: color(document.querySelector(".timeline-empty")!),
        };
      });
      expect(new Set(palette.levels).size).toBe(5);
      expect(palette.scored).toBe(palette.levels[4]);
      expect(palette.levels).not.toContain(palette.empty);
      for (let level = 0; level < 5; level++)
        for (let channel = 0; channel < 3; channel++)
          expect(
            Math.abs(
              palette.samples[level]![channel]! -
                palette.expected[level]![channel]!,
            ),
          ).toBeLessThanOrEqual(1);
    }
    for (const width of [1280, 940, 390, 360, 1280]) {
      await b.page.setViewportSize({ width, height: 1000 });
      const layout = await b.ui.locator(".bars").evaluateAll(async (lines) => {
        const deadline = performance.now() + 3000;
        let result;
        do {
          result = lines.map((line) => {
            const box = line.getBoundingClientRect(),
              style = getComputedStyle(line),
              size = parseFloat(style.getPropertyValue("--timeline-cell")),
              gap = parseFloat(style.columnGap),
              capacity = Math.max(
                0,
                Math.floor((box.width + gap) / (size + gap)),
              ),
              cells = [...line.children].map((node) => {
                const rect = node.getBoundingClientRect();
                return {
                  width: rect.width,
                  height: rect.height,
                  right: rect.right,
                  y: rect.y,
                  id:
                    (node as HTMLElement).dataset.batch ||
                    (node as HTMLElement).dataset.id ||
                    null,
                  background: getComputedStyle(node).backgroundColor,
                };
              });
            return {
              capacity,
              right: box.right,
              cells,
              overflow: line.scrollWidth > line.clientWidth,
            };
          });
          if (result.every((line) => line.cells.length === line.capacity))
            break;
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        } while (performance.now() < deadline);
        return result;
      });
      expect(layout).toHaveLength(4);
      for (const line of layout) {
        expect(line.cells).toHaveLength(line.capacity);
        expect(line.overflow).toBe(false);
        expect(Math.abs(line.cells.at(-1)!.right - line.right)).toBeLessThan(1);
        expect(
          line.cells.every(
            (cell) =>
              cell.width === 18 &&
              cell.height === 18 &&
              cell.y === line.cells[0]!.y,
          ),
        ).toBe(true);
      }
      expect(layout[0]!.cells[0]!.background).toBe(
        layout[3]!.cells[0]!.background,
      );
      expect(layout[1]!.cells.at(-1)!.id).toBe("shared-batch-99");
      expect(layout[2]!.cells.at(-1)!.id).toBe("older-batch");
      expect(await b.ui.locator(".fp-row .axis").first().innerText()).toContain(
        `展示最近 ${layout[1]!.capacity} 条 / 共 100 条`,
      );
      expect(
        await b.ui.locator(".fp-row .bars .timeline-boundary").count(),
      ).toBe(2);
      expect(
        await b.ui
          .locator("body")
          .evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBe(true);
    }
    const before = await b.ui.locator(".fp-card").innerText();
    await b.ui.locator('[data-action="period"][data-hours="168"]').click();
    await b.ui.locator('[data-action="scope"]').click();
    expect(await b.ui.locator(".fp-card").innerText()).toBe(before);
    await b.ui.locator('[data-action="fp-history"]').click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(100);
    await b.ui.getByRole("button", { name: "下一页 →", exact: true }).click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(1);
    expect(
      await b.ui.locator('.historyrecord[data-batch="older-batch"]').count(),
    ).toBe(1);
    await b.ui.getByRole("button", { name: "← 上一页", exact: true }).click();
    await b.ui.locator('[data-fp-change="history-range"]').selectOption("7");
    expect(await b.ui.locator(".historyrecord").count()).toBe(100);
    expect(
      await b.ui.locator('.historyrecord[data-batch="older-batch"]').count(),
    ).toBe(0);
    await b.ui.locator('[data-action="fp-history-scope"]').click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(99);
    await b.ui.locator("#dialog .close").click();
    await b.ui.locator("#overlay").waitFor({ state: "hidden" });
    expect(await b.ui.locator(".fp-card").innerText()).toBe(before);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.setViewportSize({ width: 1280, height: 1400 });
    await b.page.screenshot({
      path: resolve(".test-artifacts/shared-cards-desktop.png"),
    });
    await b.page.setViewportSize({ width: 390, height: 2200 });
    await b.page.screenshot({
      path: resolve(".test-artifacts/shared-cards-mobile.png"),
    });
    expect(
      b.messages.filter((m) =>
        /Uncaught|ReferenceError|ResizeObserver loop/.test(m),
      ),
    ).toEqual([]);
  } finally {
    await b.close();
  }
}, 30000);

test("fingerprint catalog refresh fills options without replacing an unsaved draft", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  try {
    await b.page.route("**/api/state", async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.connection.models = [];
      data.connection.updatedAt = null;
      await route.fulfill({ json: data });
    });
    await b.page.route("**/api/catalog", async (route) => {
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.page.reload();
    await started;
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new"]').click();
    await b.ui.locator('#fp-form [name="name"]').fill("Cold fingerprint draft");
    expect(await b.ui.locator('[data-field="target"]').inputValue()).toBe("");
    expect(await b.ui.locator('[data-action="fp-catalog"]').isDisabled()).toBe(
      true,
    );
    await b.page.unroute("**/api/state");
    release();
    await b.ui.locator('[data-action="fp-catalog"]:enabled').waitFor();
    expect(await b.ui.locator('[data-field="target"] option').count()).toBe(4);
    expect(await b.ui.locator('[data-field="target"]').inputValue()).toBe("");
    expect(await b.ui.locator('#fp-form [name="name"]').inputValue()).toBe(
      "Cold fingerprint draft",
    );
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("variant A production editor saves independent rows inside the scripts-only sandbox", async () => {
  const b = await embedded(() => ({ text: "37" }));
  try {
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new"]').click();
    await b.ui.locator('#fp-form [name="name"]').fill("指纹沙盒回归");
    expect(await b.ui.locator('[name="samples"]').inputValue()).toBe("50");
    expect(await b.ui.locator('[name="intervalMinutes"]').inputValue()).toBe(
      "1440",
    );
    expect(await b.ui.locator('[name="enabled"]').isChecked()).toBe(false);
    await b.ui.locator('[data-action="fp-add"]').click();
    await b.ui
      .locator('[data-fp-row="0"] [data-field="name"]')
      .fill("Same target high");
    await b.ui
      .locator('[data-fp-row="0"] [data-field="effort"]')
      .selectOption("high");
    await b.ui
      .locator('[data-fp-row="1"] [data-field="name"]')
      .fill("Same target medium");
    await b.ui
      .locator('[data-fp-row="1"] [data-field="effort"]')
      .selectOption("medium");
    await b.ui.getByRole("button", { name: "保存配置", exact: true }).click();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    const state = (await b.f.api("state")).data;
    expect(state.objects).toHaveLength(0);
    expect(state.fingerprints).toHaveLength(1);
    expect(state.fingerprints[0].rows.map((r: any) => r.effort)).toEqual([
      "high",
      "medium",
    ]);
    expect(state.fingerprints[0].rows[0].id).not.toBe(
      state.fingerprints[0].rows[1].id,
    );
    await b.ui.locator(".fp-card").waitFor();
    expect(await b.ui.locator(".fp-card").count()).toBe(1);
    await b.ui.locator(".fp-row .timeline-empty").nth(2).waitFor();
    expect(
      await b.ui.locator(".fp-row .timeline-empty").count(),
    ).toBeGreaterThan(2);
    expect(b.f.calls).toHaveLength(0);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: resolve(".test-artifacts/fingerprint-A-desktop.png"),
    });
    expect(
      b.messages.filter((m) => /Blocked form|Uncaught|ReferenceError/.test(m)),
    ).toHaveLength(0);
    await b.page.setViewportSize({ width: 390, height: 844 });
    expect(
      await b.ui
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
    await b.page.screenshot({
      path: resolve(".test-artifacts/fingerprint-A-mobile.png"),
    });
    for (const lang of ["en", "zh"]) {
      await b.page.evaluate(
        (lang) =>
          (
            document.querySelector("#monitor") as HTMLIFrameElement
          ).contentWindow!.postMessage(
            { magpie: 1, event: "theme", data: { lang, dark: false } },
            "*",
          ),
        lang,
      );
      await b.ui
        .locator(`html[lang="${lang === "zh" ? "zh-CN" : lang}"]`)
        .waitFor();
      expect(await b.ui.locator("#overlay.open").count()).toBe(0);
    }
    await b.ui.locator('[data-action="fp-edit"]').click();
    await b.ui
      .locator('#fp-form [name="name"]')
      .fill("Unsaved fingerprint draft");
    for (const [lang, label] of [
      ["en", "Edit fingerprint monitor"],
      ["zh-TW", "編輯指紋監測"],
      ["ja", "指紋モニターを編集"],
      ["de", "Fingerabdruck-Monitor bearbeiten"],
    ]) {
      await b.page.evaluate((lang) => {
        (
          document.querySelector("#monitor") as HTMLIFrameElement
        ).contentWindow!.postMessage(
          { magpie: 1, event: "theme", data: { lang, dark: true } },
          "*",
        );
      }, lang);
      await b.ui.getByRole("heading", { name: label, exact: true }).waitFor();
      expect(await b.ui.locator('#fp-form [name="name"]').inputValue()).toBe(
        "Unsaved fingerprint draft",
      );
      expect(
        await b.ui
          .locator("#dialog")
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
    }
    expect(await b.ui.locator("html").getAttribute("data-theme")).toBe("dark");
  } finally {
    await b.close();
  }
}, 30000);

test("unscored latest batch, chart ranges, library import and global type filters", async () => {
  const b = await embedded(() => ({ text: "37" }));
  try {
    const r = (await b.f.api("baselines", "POST", [baseline()])).data[0];
    const o = (
      await b.f.api("objects", "POST", {
        type: "fingerprint",
        name: "Real API card",
        samples: 2,
        rows: [{ target: "test/model", baselineId: r.id }],
      })
    ).data;
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.f.api(`objects/${o.id}`, "PUT", { ...o, samples: 3 });
    await b.f.object();
    await b.page.reload();
    await b.ui.locator(".fp-card").waitFor();
    expect(await b.ui.locator(".fp-result").innerText()).toContain("未评分");
    expect(await b.ui.locator(".fp-result").innerText()).toContain(
      "有效样本不足 40",
    );
    expect(await b.ui.locator(".fp-card select, .fp-meta").count()).toBe(0);
    await b.ui.locator('[data-action="fp-history"]').click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(1);
    await b.ui.locator('[data-action="fp-history-scope"]').click();
    expect(await b.ui.locator(".historyrecord").count()).toBe(0);
    await b.ui.locator("#dialog .close").click();
    expect(await b.ui.locator(".fp-result").innerText()).toContain("未评分");
    expect(await b.ui.locator('.fp-cell[data-action="fp-batch"]').count()).toBe(
      1,
    );
    const metrics = await b.ui.locator(".metricrow").innerText();
    await b.ui
      .locator('[data-action="fp-filter"][data-filter="fingerprint"]')
      .click();
    expect(await b.ui.locator(".metricrow").innerText()).toBe(metrics);
    expect(await b.ui.locator(".card").count()).toBe(1);
    await b.ui.locator('.fp-cell[data-action="fp-batch"]').click();
    await b.ui.getByRole("heading", { name: "采样批次详情" }).waitFor();
    expect(await b.ui.locator(".detailblock").innerText()).toContain(
      "固定参考基准：Synthetic reference",
    );
    expect(await b.ui.locator(".fp-chart .sample").count()).toBe(1);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: resolve(".test-artifacts/fingerprint-A-detail.png"),
    });
    await b.ui.locator('[data-fp-change="full"]').check();
    expect(await b.ui.locator(".fp-chart .sample").count()).toBe(355);
    await b.ui.getByText("逐次采样明细", { exact: true }).click();
    await b.ui.locator('[data-action="fp-samples"]').click();
    await b.ui.locator("#fp-samples tbody tr").first().waitFor();
    expect(await b.ui.locator("#fp-samples tbody tr").count()).toBe(2);
    await b.ui.locator("#dialog .close").click();
    await b.ui.locator('[data-action="fp-library"]').click();
    await b.ui
      .locator("#fp-import")
      .fill(JSON.stringify([baseline(73, '<img src=x onerror="alert(1)">')]));
    await b.ui.locator('[data-action="fp-import"]').click();
    await b.ui
      .getByText('<img src=x onerror="alert(1)">', { exact: true })
      .waitFor();
    expect(await b.ui.locator("#dialog img").count()).toBe(0);
    expect(
      b.messages.filter((m) =>
        /Uncaught|ReferenceError|Content Security Policy/.test(m),
      ),
    ).toHaveLength(0);
  } finally {
    await b.close();
  }
}, 30000);
