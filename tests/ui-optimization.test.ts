import { test, expect } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { embedded } from "./browser.ts";

test("missing CLI shows actionable translated diagnostics without blaming Codex connection or hiding history", async () => {
  const b = await embedded();
  try {
    const object = await b.f.object();
    await b.f.api(`objects/${object.id}/run`, "POST", {});
    await b.f.app.idle();
    b.f.access.magpiePath = join(b.f.directory, "missing.exe");
    expect((await b.f.api("catalog")).status).toBe(409);
    await b.page.reload();
    for (const [lang, expected] of [
      [
        "zh",
        "找不到 Magpie CLI；请在设置中填写正在运行的 Magpie 可执行文件绝对路径",
      ],
      [
        "en",
        "Magpie CLI not found; enter the running Magpie executable's absolute path in Settings",
      ],
      [
        "zh-TW",
        "找不到 Magpie CLI；請在設定中填寫正在執行的 Magpie 執行檔絕對路徑",
      ],
      [
        "ja",
        "Magpie CLI が見つかりません。設定で実行中の Magpie の絶対パスを指定してください",
      ],
      [
        "de",
        "Magpie CLI nicht gefunden; absoluten Pfad der laufenden Magpie-Datei in den Einstellungen angeben",
      ],
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
      const warning = b.ui.locator(".connection.warning");
      await warning.filter({ hasText: expected }).waitFor();
      expect(await warning.innerText()).toBe(expected);
    }
    expect((await b.f.api("export")).data.records).toHaveLength(1);
    expect(b.f.calls).toHaveLength(1);
    expect(
      await b.ui.locator('.cardhead [data-action="run"]').isDisabled(),
    ).toBe(false);
  } finally {
    await b.close();
  }
}, 30000);

test("toggle feedback is immediate, survives rendering and recovers from failure", async () => {
  const b = await embedded();
  let release = () => {};
  try {
    const o = await b.f.object();
    await b.page.reload();
    const toggle = b.ui.locator('[data-action="toggle"]');
    for (const failing of [false, true]) {
      const gate = new Promise<void>((r) => (release = r));
      let requests = 0;
      await b.page.route(`**/api/objects/${o.id}`, async (route) => {
        requests++;
        await gate;
        if (failing)
          await route.fulfill({
            status: 409,
            json: { error: "Toggle fixture failure" },
          });
        else await route.continue();
      });
      const request = b.page.waitForRequest(`**/api/objects/${o.id}`);
      await toggle.click();
      await request;
      expect(await toggle.innerText()).toBe(
        failing ? "正在暂停…" : "正在启用…",
      );
      expect(await toggle.isDisabled()).toBe(true);
      expect(await toggle.getAttribute("aria-busy")).toBe("true");
      expect((await b.f.api("state")).data.objects[0].enabled).toBe(failing);
      await b.ui
        .getByRole("button", { name: "最近 7 天", exact: true })
        .click();
      expect(await toggle.isDisabled()).toBe(true);
      expect(await b.ui.locator('[data-action="run"]:enabled').count()).toBe(0);
      await toggle.evaluate((el) => (el as HTMLButtonElement).click());
      expect(requests).toBe(1);
      release();
      await b.ui.locator('[data-action="toggle"]:enabled').waitFor();
      expect(await toggle.innerText()).toBe("暂停监测");
      expect((await b.f.api("state")).data.objects[0].enabled).toBe(true);
      if (failing)
        expect(await b.ui.locator("#toast").innerText()).toBe(
          "Toggle fixture failure",
        );
      await b.page.unroute(`**/api/objects/${o.id}`);
    }
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("single and whole-round submissions disable related buttons before acceptance", async () => {
  const b = await embedded();
  let release = () => {};
  try {
    const o = await b.f.object();
    for (const single of [true, false]) {
      await b.page.reload();
      const gate = new Promise<void>((r) => (release = r));
      let requests = 0;
      await b.page.route(`**/api/objects/${o.id}/run`, async (route) => {
        requests++;
        await gate;
        await route.continue();
      });
      const run = b.ui.locator(
        single
          ? '.logicitem [data-action="run"]'
          : '.cardhead [data-action="run"]',
      );
      const request = b.page.waitForRequest(`**/api/objects/${o.id}/run`);
      await run.click();
      const sent = await request;
      expect(sent.postDataJSON()).toEqual(
        single ? { testId: o.tests[0].id } : {},
      );
      expect(await run.innerText()).toBe("正在提交…");
      expect(await run.isDisabled()).toBe(true);
      expect(await b.ui.locator('[data-action="toggle"]').isDisabled()).toBe(
        true,
      );
      expect(await b.ui.locator('[data-action="run"]:enabled').count()).toBe(0);
      await run.evaluate((el) => (el as HTMLButtonElement).click());
      expect(requests).toBe(1);
      release();
      await b.ui.locator('[data-action="toggle"]:enabled').waitFor();
      await b.f.app.idle();
      await b.page.unroute(`**/api/objects/${o.id}/run`);
    }
    expect(b.f.calls).toHaveLength(2);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("a mutation queues a fresh state read after an older poll instead of waiting five seconds", async () => {
  const b = await embedded();
  let release = () => {};
  try {
    const o = await b.f.object();
    await b.page.clock.install();
    await b.page.clock.pauseAt(new Date(Date.now() + 1000));
    await b.page.reload();
    await b.ui.locator('[data-action="toggle"]').waitFor();
    const gate = new Promise<void>((r) => (release = r));
    let entered = () => {};
    const started = new Promise<void>((r) => (entered = r));
    let reads = 0;
    await b.page.route("**/api/state", async (route) => {
      reads++;
      const response = await route.fetch();
      if (reads === 1) {
        entered();
        await gate;
      }
      await route.fulfill({ response });
    });
    await b.page.clock.runFor(5000);
    await started;
    const accepted = b.page.waitForResponse(`**/api/objects/${o.id}`);
    await b.ui.locator('[data-action="toggle"]').click();
    expect((await accepted).status()).toBe(200);
    expect((await b.f.api("state")).data.objects[0].enabled).toBe(true);
    release();
    await b.ui.locator('[data-action="toggle"]:enabled').waitFor();
    expect(await b.ui.locator('[data-action="toggle"]').innerText()).toBe(
      "暂停监测",
    );
    expect(await b.ui.locator('.cardhead [role="status"]').innerText()).toBe(
      "监测中",
    );
    expect(reads).toBe(2);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("pending and failed catalog refreshes do not block existing objects or erase their target", async () => {
  const b = await embedded();
  let release = () => {};
  try {
    const o = await b.f.object();
    await b.page.reload();
    await b.ui.locator('[data-action="refresh-catalog"]:enabled').waitFor();
    const gate = new Promise<void>((r) => (release = r));
    await b.page.route("**/api/catalog", async (route) => {
      await gate;
      await route.fulfill({
        status: 409,
        json: { error: "Catalog fixture failure" },
      });
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.ui.locator('[data-action="refresh-catalog"]').click();
    await started;
    expect(
      await b.ui.locator('.cardhead [data-action="run"]').isEnabled(),
    ).toBe(true);
    await b.ui.locator('[data-action="toggle"]').click();
    await b.ui.locator('[data-action="toggle"]:enabled').waitFor();
    expect(await b.ui.locator('[data-action="toggle"]').innerText()).toBe(
      "暂停监测",
    );
    release();
    await b.ui
      .locator(".catalog-feedback")
      .filter({ hasText: "Catalog fixture failure" })
      .waitFor();
    expect(
      await b.ui.locator('.cardhead [data-action="run"]').isEnabled(),
    ).toBe(true);
    writeFileSync(
      b.f.catalogFile,
      "  Provider\n  group/analysis  Analysis  high\n  " +
        b.f.link.baseURL +
        "\n",
    );
    await b.f.api("catalog");
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await b.ui.locator('[name="objectName"]').fill("Preserved target");
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe(o.target);
    await b.ui.getByRole("button", { name: "保存配置", exact: true }).click();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    const saved = (await b.f.api("state")).data.objects[0];
    expect(saved.target).toBe(o.target);
    expect(saved.name).toBe("Preserved target");
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("drawing captions stay with the displayed artwork across edits and failed attempts", async () => {
  let failing = false;
  let advance = () => {};
  const b = await embedded(() => {
    advance();
    return failing
      ? { status: 502 }
      : { text: '<html><body style="height:200px">Saved art</body></html>' };
  });
  try {
    advance = () => b.f.setNow(b.f.now + 141000);
    const o = await b.f.object({
      tests: [{ kind: "drawing", name: "Bird", prompt: "Draw old" }],
    });
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    const records = (await b.f.api("export")).data.records;
    await b.f.api(`objects/${o.id}`, "PUT", {
      ...o,
      tests: o.tests.map((t: any) => ({ ...t, prompt: "Draw new" })),
    });
    failing = true;
    await b.f.api(`objects/${o.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.page.reload();
    const caption = b.ui.locator(".artcaption");
    await caption.waitFor();
    expect(await caption.innerText()).toContain("创建于");
    expect(await caption.innerText()).toContain("耗时 2.35 分钟");
    expect(await caption.innerText()).toContain("Token 0.02k");
    expect(await caption.innerText()).toContain("来自旧配置");
    expect(await b.ui.locator(".testrow .warning").innerText()).toContain(
      "当前展示旧作品",
    );
    await b.ui.getByRole("button", { name: "历史图片 ↗", exact: true }).click();
    await b.ui.locator("[data-gallery-id]").first().waitFor();
    expect(await b.ui.locator("[data-gallery-id]").count()).toBe(1);
    await b.ui.getByRole("button", { name: "放大", exact: true }).click();
    await b.ui
      .locator("#dialog pre")
      .filter({ hasText: "Draw old" })
      .first()
      .waitFor();
    expect(await b.ui.locator("#dialog").innerText()).toContain("Draw old");
    expect((await b.f.api("records/" + records[0].id)).data).toEqual(
      records[0],
    );
    await b.ui.locator("#dialog .close").click();
    await b.page.screenshot({
      path: ".test-artifacts/codex-monitor-caption.png",
    });
  } finally {
    await b.close();
  }
}, 30000);
