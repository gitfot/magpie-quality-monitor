import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { embedded } from "./browser.ts";

test("overview catalog cold start refreshes automatically and shares loading with the editor", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    const object = await b.f.object();
    await b.f.api(`objects/${object.id}/run`, "POST", {});
    await b.f.app.idle();
    const before = (await b.f.api("export")).data;
    await b.ui
      .locator('[data-action="refresh-catalog"]:not(:disabled)')
      .waitFor();
    await b.f.restart(Number(new URL(b.f.app.url).port));
    expect((await b.f.api("state")).data.connection.updatedAt).toBeNull();
    let requests = 0;
    await b.page.route("**/api/catalog", async (route) => {
      requests++;
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog", { timeout: 3000 });
    await b.page.reload();
    await started;
    const refresh = b.ui.locator('[data-action="refresh-catalog"]');
    expect(await refresh.isDisabled()).toBe(true);
    expect(await refresh.getAttribute("aria-busy")).toBe("true");
    expect(await refresh.innerText()).toBe("正在刷新…");
    expect(
      await refresh.locator('.catalog-spinner[aria-hidden="true"]').count(),
    ).toBe(1);
    expect(
      await refresh
        .locator(".catalog-spinner")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).not.toBe("none");
    expect(
      await b.ui.locator('.catalog-feedback[role="status"]').innerText(),
    ).toBe("正在刷新模型目录…");
    expect(await b.ui.locator(".connection.warning:visible").count()).toBe(0);
    expect(await b.ui.locator(".card h2").innerText()).toBe("Primary");
    expect(await b.ui.locator(".bars button").count()).toBe(1);
    expect(await b.ui.locator("#app").innerText()).not.toContain(
      "尚未读取原生 Codex",
    );
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await b.ui.locator('.picker[aria-busy="true"]').waitFor();
    await b.ui.locator('[name="objectName"]').fill("Cold-start draft");
    await b.ui.locator('[name="prompt"]').focus();
    expect(requests).toBe(1);
    release();
    await b.ui.locator('.picker[aria-busy="false"]').waitFor();
    expect(await refresh.isEnabled()).toBe(true);
    expect(await refresh.innerText()).toBe("刷新 Codex 目录");
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "Cold-start draft",
    );
    expect(
      await b.ui
        .locator('[name="prompt"]')
        .evaluate((el) => document.activeElement === el),
    ).toBe(true);
    await b.ui.locator("#dialog .close").click();
    await b.ui.getByText("原生 Codex 已接入", { exact: true }).waitFor();
    const poll = b.page.waitForResponse("**/api/state");
    await poll;
    expect(requests).toBe(1);
    expect((await b.f.api("export")).data).toEqual(before);
    expect(b.f.calls).toHaveLength(1);
    await b.page.reload();
    await b.ui
      .locator('[data-action="refresh-catalog"][aria-busy="false"]')
      .waitFor();
    expect(requests).toBe(2);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("overview catalog manual refresh shows loading in every language without losing history", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await b.f.object();
    await b.page.reload();
    const refresh = b.ui.locator('[data-action="refresh-catalog"]');
    await b.ui
      .locator('[data-action="refresh-catalog"]:not(:disabled)')
      .waitFor();
    let requests = 0;
    await b.page.route("**/api/catalog", async (route) => {
      requests++;
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await refresh.click();
    await started;
    expect(await refresh.isDisabled()).toBe(true);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/catalog-loading-desktop.png",
    });
    for (const [lang, busy, status] of [
      ["zh", "正在刷新…", "正在刷新模型目录…"],
      ["en", "Refreshing…", "Refreshing model catalog…"],
      ["zh-TW", "正在重新整理…", "正在重新整理模型目錄…"],
      ["ja", "更新中…", "モデル一覧を更新中…"],
      ["de", "Wird aktualisiert…", "Modellkatalog wird aktualisiert…"],
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
      await refresh.filter({ hasText: busy }).waitFor();
      expect(await b.ui.locator(".catalog-feedback").innerText()).toBe(status);
      expect(await refresh.isDisabled()).toBe(true);
    }
    await b.page.setViewportSize({ width: 360, height: 900 });
    await b.page.screenshot({
      path: ".test-artifacts/catalog-loading-mobile.png",
    });
    expect(
      await b.ui.locator("#app").evaluate(async (el) => {
        const deadline = performance.now() + 3000;
        while (el.scrollWidth > el.clientWidth && performance.now() < deadline)
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
        if (el.scrollWidth > el.clientWidth)
          throw Error(
            JSON.stringify(
              [...el.querySelectorAll("*")]
                .filter(
                  (child) =>
                    child.getBoundingClientRect().right >
                    el.getBoundingClientRect().right,
                )
                .map((child) => ({
                  tag: child.tagName,
                  class: child.className,
                  text: child.textContent?.slice(0, 80),
                })),
            ),
          );
        return true;
      }),
    ).toBe(true);
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/catalog-loading-mobile.png",
    });
    expect(requests).toBe(1);
    release();
    await b.ui
      .locator('[data-action="refresh-catalog"][aria-busy="false"]')
      .waitFor();
    expect(await refresh.isEnabled()).toBe(true);
    expect(await refresh.locator(".catalog-spinner").count()).toBe(0);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("overview catalog failure clears loading, remains visible after polling and allows one manual retry", async () => {
  const b = await embedded();
  try {
    const object = await b.f.object();
    const before = (await b.f.api("state")).data.objects[0];
    await b.page.reload();
    await b.ui
      .locator('[data-action="refresh-catalog"]:not(:disabled)')
      .waitFor();
    let requests = 0;
    await b.page.route("**/api/catalog", (route) => {
      requests++;
      return route.fulfill({
        status: 409,
        json: { error: "Catalog fixture unavailable" },
      });
    });
    await b.ui.locator('[data-action="refresh-catalog"]').click();
    await b.ui
      .locator(".catalog-feedback.warning")
      .filter({ hasText: "Catalog fixture unavailable" })
      .waitFor({ timeout: 3000 });
    expect(
      await b.ui.locator('[data-action="refresh-catalog"]').isEnabled(),
    ).toBe(true);
    expect(await b.ui.locator(".catalog-spinner").count()).toBe(0);
    await b.page.waitForResponse("**/api/state");
    expect(await b.ui.locator(".catalog-feedback").innerText()).toBe(
      "Catalog fixture unavailable",
    );
    expect(requests).toBe(1);
    await b.page.unroute("**/api/catalog");
    await b.ui.locator('[data-action="refresh-catalog"]').click();
    await b.ui
      .locator('[data-action="refresh-catalog"][aria-busy="false"]')
      .waitFor();
    expect(await b.ui.locator(".catalog-feedback:visible").count()).toBe(0);
    expect((await b.f.api("state")).data.objects[0]).toEqual(before);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    await b.close();
  }
}, 30000);

for (const mode of ["new", "edit"]) {
  test(`${mode} editor opens before catalog completes and refresh preserves the live draft`, async () => {
    const b = await embedded();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    try {
      await b.f.object();
      await b.page.reload();
      let requests = 0;
      await b.page.route("**/api/catalog", async (route) => {
        requests++;
        await gate;
        await route.continue();
      });
      const started = b.page.waitForRequest("**/api/catalog");
      await b.ui
        .getByRole("button", {
          name: mode === "new" ? "＋ 新建监测对象" : "编辑",
          exact: true,
        })
        .click();
      if (mode === "new")
        await b.ui.locator('[data-action="fp-new-legacy"]').click();
      await started;
      // The request stays held until after the form is visible and editable.
      await b.ui.locator("#objectform").waitFor();
      await b.ui.locator('[name="objectName"]').fill("Unsubmitted draft");
      if (mode === "new")
        await b.ui
          .getByRole("button", { name: "＋ 逻辑题", exact: true })
          .click();
      await b.ui.locator('[name="prompt"]').fill("Unsaved prompt\nSecond line");
      await b.ui.locator('[name="answers"]').fill("42\n四十二");
      await b.ui.locator(".picker summary").click();
      await b.ui
        .getByRole("button", {
          name: "Reasoning · group/reasoning",
          exact: true,
        })
        .click();
      expect(await b.ui.locator('[name="target"]').getAttribute("type")).toBe(
        "hidden",
      );
      expect(await b.ui.locator(".picker summary").innerText()).toContain(
        "Reasoning · group/reasoning",
      );
      expect(await b.ui.locator(".picker").innerText()).toContain(
        "正在刷新模型目录…",
      );
      await b.ui.locator('[name="prompt"]').focus();
      const form = await b.ui.locator("#objectform").elementHandle();
      release();
      await b.ui.locator('.picker[aria-busy="false"]').waitFor();
      expect(
        await b.ui
          .locator("#objectform")
          .evaluate((el, old) => el === old, form),
      ).toBe(true);
      expect(
        await b.ui
          .locator('[name="prompt"]')
          .evaluate((el) => document.activeElement === el),
      ).toBe(true);
      expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
        "Unsubmitted draft",
      );
      expect(await b.ui.locator('[name="prompt"]').inputValue()).toBe(
        "Unsaved prompt\nSecond line",
      );
      expect(await b.ui.locator('[name="answers"]').inputValue()).toBe(
        "42\n四十二",
      );
      expect(await b.ui.locator('[name="target"]').inputValue()).toBe(
        "group/reasoning",
      );
      expect(requests).toBe(1);
      expect((await b.f.api("state")).data.objects[0].name).toBe("Primary");
      expect(b.f.calls).toHaveLength(0);
    } finally {
      release();
      await b.close();
    }
  }, 30000);
}

test("an empty cached catalog does not delay opening and options arrive without replacing the form", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await b.page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.connection.models = [];
      data.connection.updatedAt = null;
      await route.fulfill({ json: data });
    });
    await b.page.reload();
    await b.page.route("**/api/catalog", async (route) => {
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    await started;
    await b.ui.locator("#objectform").waitFor();
    await b.ui.locator('[name="objectName"]').fill("Cold draft");
    expect(await b.ui.locator('.picker[aria-busy="true"]').count()).toBe(1);
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe("");
    await b.page.unroute("**/api/state");
    release();
    await b.ui.locator('.picker[aria-busy="false"]').waitFor();
    await b.ui.locator(".picker summary").click();
    expect(await b.ui.locator('[data-action="pick-model"]').count()).toBe(3);
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "Cold draft",
    );
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe("");
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("failed and late catalog refreshes neither clear the target nor reopen or overwrite another dialog", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await b.f.object();
    await b.page.reload();
    await b.page.route("**/api/catalog", (route) =>
      route.fulfill({
        status: 409,
        json: { error: "Catalog fixture unavailable" },
      }),
    );
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await b.ui
      .locator(".catalog-status")
      .filter({ hasText: "Catalog fixture unavailable" })
      .waitFor();
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe(
      "test/model",
    );
    await b.ui.locator('[name="objectName"]').fill("Keep this draft");
    await b.page.unroute("**/api/catalog");
    let requests = 0;
    await b.page.route("**/api/catalog", async (route) => {
      requests++;
      await gate;
      await route.fulfill({
        status: 409,
        json: { error: "Late catalog failure" },
      });
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.ui
      .getByRole("button", { name: "刷新模型与路由目录", exact: true })
      .click();
    await started;
    expect(
      await b.ui
        .getByRole("button", { name: "刷新模型与路由目录", exact: true })
        .isDisabled(),
    ).toBe(true);
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "Keep this draft",
    );
    await b.ui.locator("#dialog .close").click();
    await b.ui.getByRole("button", { name: "设置", exact: true }).click();
    await b.ui.locator('[name="retentionDays"]').fill("9");
    const finished = b.page.waitForResponse("**/api/catalog");
    release();
    await finished;
    await b.ui.locator('[name="retentionDays"]').press("Tab");
    expect(await b.ui.locator("#objectform").count()).toBe(0);
    expect(await b.ui.locator('[name="retentionDays"]').inputValue()).toBe("9");
    expect(await b.ui.locator("#formerror").innerText()).toBe("");
    expect(requests).toBe(1);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("a model removed by refresh stays selected with an explicit warning, never a replacement", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await b.f.object({ target: "group/reasoning" });
    await b.page.reload();
    await b.page.route("**/api/catalog", async (route) => {
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await started;
    await b.ui.locator('[name="objectName"]').fill("Keep removed target");
    writeFileSync(
      b.f.catalogFile,
      readFileSync(b.f.catalogFile, "utf8").replace(
        /  group\/reasoning[^\n]*\n/,
        "",
      ),
    );
    release();
    await b.ui
      .locator(".catalog-status")
      .filter({ hasText: "所选模型已不在 Codex 可见目录中" })
      .waitFor();
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe(
      "group/reasoning",
    );
    expect(await b.ui.locator(".picker summary").innerText()).toContain(
      "group/reasoning",
    );
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "Keep removed target",
    );
    expect(await b.ui.locator('[data-action="pick-model"]').count()).toBe(2);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("closing and reopening an editor shares the pending refresh without reviving the previous draft", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    await b.f.object();
    await b.page.reload();
    let requests = 0;
    await b.page.route("**/api/catalog", async (route) => {
      requests++;
      await gate;
      await route.continue();
    });
    const started = b.page.waitForRequest("**/api/catalog");
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await started;
    await b.ui.locator('[name="objectName"]').fill("Discarded editor draft");
    await b.ui.locator("#dialog .close").click();
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    await b.ui.locator('[name="objectName"]').fill("New editor draft");
    release();
    await b.ui.locator('.picker[aria-busy="false"]').waitFor();
    expect(await b.ui.locator("#dialog h2").innerText()).toBe("新建监测对象");
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "New editor draft",
    );
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe("");
    expect(requests).toBe(1);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("the single catalog dropdown is keyboard accessible, translated and contained on mobile", async () => {
  const b = await embedded();
  try {
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    await b.ui.locator('.picker[aria-busy="false"]').waitFor();
    expect(await b.ui.locator('[name="target"]:visible').count()).toBe(0);
    expect(await b.ui.locator("select").count()).toBe(0);
    expect(await b.ui.locator(".picker summary").count()).toBe(1);
    await b.ui.locator(".picker summary").focus();
    await b.ui.locator(".picker summary").press("Enter");
    await b.ui
      .getByRole("button", { name: "Model · test/model", exact: true })
      .focus();
    await b.ui
      .getByRole("button", { name: "Model · test/model", exact: true })
      .press("Enter");
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe(
      "test/model",
    );
    expect(
      await b.ui.locator(".picker details").getAttribute("open"),
    ).toBeNull();
    for (const [lang, label] of [
      ["en", "Models visible to Codex"],
      ["zh-TW", "Codex 可見模型"],
      ["ja", "Codex の表示モデル"],
      ["de", "Für Codex sichtbare Modelle"],
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
      await b.ui.locator(".picker").filter({ hasText: label }).waitFor();
      expect(await b.ui.locator(".picker summary").innerText()).toContain(
        "Model · test/model",
      );
    }
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: ".test-artifacts/editor-dropdown-desktop.png",
    });
    await b.page.setViewportSize({ width: 420, height: 900 });
    await b.ui.locator(".picker summary").click();
    expect(
      await b.ui
        .locator("#dialog")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await b.page.screenshot({
      path: ".test-artifacts/editor-dropdown-mobile.png",
    });
    expect(b.f.calls).toHaveLength(0);
  } finally {
    await b.close();
  }
}, 30000);
