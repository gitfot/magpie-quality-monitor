import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { embedded } from "./browser.ts";

test("compact cards distinguish running and queued paused objects and honor reduced motion", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (entered = r));
  const b = await embedded(async () => {
    entered();
    await gate;
    return { text: "FINAL_ANSWER: 21 个" };
  });
  try {
    const a = await b.f.object({
      name: "Running",
      tests: [
        { kind: "logic", name: "Candy", prompt: "Solve", answers: ["21个"] },
        {
          kind: "logic",
          name: "Knowledge",
          prompt: "Solve",
          answers: ["21个"],
        },
      ],
    });
    const q = await b.f.object({ name: "Queued" });
    await b.f.api(`objects/${a.id}/run`, "POST", {});
    await started;
    await b.f.api(`objects/${q.id}/run`, "POST", {});
    await b.page.reload();
    await b.ui.locator(".status-running").waitFor();
    expect(await b.ui.locator(".status-running").textContent()).toBe("执行中");
    expect(await b.ui.locator(".status-queued").textContent()).toBe("排队中");
    expect(
      await b.ui
        .locator(".status-running")
        .evaluate((el) => getComputedStyle(el, "::before").animationName),
    ).toBe("status-spin");
    await b.page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await b.ui
        .locator(".status-running")
        .evaluate((el) => getComputedStyle(el, "::before").animationName),
    ).toBe("none");
    expect(await b.ui.locator(".object-layout.single-column").count()).toBe(2);
    const card = b.ui.locator(".card").first();
    const text = await card.innerText();
    expect(text).not.toContain("没有绘图测试项");
    expect(text).not.toContain("格式异常 0");
    expect(text).not.toContain("配置 v");
    expect(text).not.toContain("最近 24 小时");
    expect((await card.boundingBox())!.height).toBeLessThan(360);
    expect(await b.ui.locator(".legend").count()).toBe(1);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({ path: ".test-artifacts/compact-running.png" });
    release();
    await b.f.app.idle();
    await b.ui.locator(".status-running").waitFor({ state: "hidden" });
    expect(await b.ui.locator(".status-paused").count()).toBe(2);
    await b.page.setViewportSize({ width: 430, height: 900 });
    expect(
      await b.ui
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    ).toBe(true);
    await b.page.screenshot({ path: ".test-artifacts/compact-mobile.png" });
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("missing-browser fallback keeps the original preview and explicit retry repairs all visible thumbnails", async () => {
  const b = await embedded(() => ({
    text: '<html><body><svg width="400" height="300"><circle cx="200" cy="150" r="100" fill="orange"/></svg></body></html>',
  }));
  try {
    await b.f.api("settings", "PUT", {
      retentionDays: 5,
      browserPath: "C:\\missing-monitor-browser\\chrome.exe",
    });
    const o = await b.f.object({
      tests: [{ kind: "drawing", name: "Fallback", prompt: "Draw" }],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.page.reload();
    await b.ui
      .getByText("未找到可用截图浏览器，请在设置中指定路径", { exact: true })
      .waitFor();
    await b.ui.getByRole("button", { name: "放大 ↗", exact: true }).click();
    await b.ui.locator(".raw-preview summary").click();
    await b.ui
      .locator("#largepreview iframe")
      .contentFrame()
      .locator("circle")
      .waitFor({ state: "attached" });
    await b.f.api("settings", "PUT", {
      retentionDays: 5,
      browserPath:
        process.platform === "win32"
          ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
          : "",
    });
    await b.ui.getByRole("button", { name: "重试截图", exact: true }).click();
    await b.ui.locator(".large-art img").waitFor();
    await b.ui.locator("#dialog .close").click();
    await b.ui.locator(".card img.thumbnail").waitFor();
    expect(b.f.calls).toHaveLength(1);
    // Settings were changed out-of-band through the fixture API, not its form.
    await b.page.reload();
    await b.ui.locator(".card img.thumbnail").waitFor();
    for (const [lang, settings, label] of [
      ["en", "Settings", "Screenshot browser path"],
      ["zh-TW", "設定", "截圖瀏覽器絕對路徑"],
      ["ja", "設定", "キャプチャ用ブラウザーの絶対パス"],
      ["de", "Einstellungen", "Absoluter Browserpfad"],
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
      await b.ui.getByRole("button", { name: settings, exact: true }).click();
      expect(await b.ui.locator("#dialog").innerText()).toContain(label);
      expect(await b.ui.locator('[name="browserPath"]').inputValue()).toContain(
        process.platform === "win32" ? "msedge.exe" : "",
      );
      await b.ui.locator("#dialog .close").click();
    }
  } finally {
    await b.close();
  }
}, 30000);

test("full-page screenshots stay within compact cards and the original preview scrolls", async () => {
  const b = await embedded(() => ({
    text: '<html><body style="margin:0"><div style="height:1800px;background:linear-gradient(#db694a,#286a82);color:white;font:64px serif">TOP<div style="padding-top:1500px">BOTTOM</div></div></body></html>',
  }));
  try {
    const o = await b.f.object({
      tests: [{ kind: "drawing", name: "Long art", prompt: "Draw" }],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.page.reload();
    const image = b.ui.locator(".card .thumbnail");
    await image.waitFor();
    await image.evaluate((el) => (el as HTMLImageElement).decode());
    expect(
      await image.evaluate((el) => (el as HTMLImageElement).naturalHeight),
    ).toBe(1800);
    expect((await b.ui.locator(".card .artstage").boundingBox())!.height).toBe(
      180,
    );
    expect(await image.evaluate((el) => getComputedStyle(el).objectFit)).toBe(
      "contain",
    );
    expect(await b.ui.locator(".card iframe").count()).toBe(0);
    const bottom = await b.page.evaluate(
      async (src) => {
        const im = new Image();
        im.src = src!;
        await im.decode();
        const c = document.createElement("canvas");
        c.width = im.naturalWidth;
        c.height = im.naturalHeight;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(im, 0, 0);
        return [...ctx.getImageData(10, im.naturalHeight - 2, 1, 1).data];
      },
      await image.getAttribute("src"),
    );
    expect(bottom[2]!).toBeGreaterThan(bottom[0]!);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({ path: ".test-artifacts/compact-art.png" });
    await b.ui.getByRole("button", { name: "放大 ↗", exact: true }).click();
    await b.ui.locator(".large-art img").waitFor();
    await b.ui.locator(".raw-preview summary").click();
    const frame = b.ui.locator("#largepreview iframe");
    await frame.contentFrame().getByText("BOTTOM", { exact: true }).waitFor();
    expect(await frame.getAttribute("sandbox")).toBe("");
    expect(
      await frame.evaluate((el) => getComputedStyle(el).pointerEvents),
    ).toBe("auto");
    await frame
      .contentFrame()
      .locator("body")
      .evaluate(() => window.scrollTo(0, 1600));
    expect(
      await frame
        .contentFrame()
        .locator("body")
        .evaluate(() => window.scrollY),
    ).toBeGreaterThan(0);
    await b.page.screenshot({ path: ".test-artifacts/compact-art-detail.png" });
  } finally {
    await b.close();
  }
}, 30000);
