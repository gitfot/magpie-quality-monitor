import { test, expect } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { embedded } from "./browser.ts";

test("saving logic configuration works inside Magpie's scripts-only sandbox", async () => {
  const b = await embedded();
  try {
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    await b.ui.locator('[name="objectName"]').fill("沙盒保存回归");
    await b.ui.locator(".picker summary").click();
    await b.ui
      .getByRole("button", { name: "Model · test/model", exact: true })
      .click();
    await b.ui.getByRole("button", { name: "＋ 逻辑题", exact: true }).click();
    const row = b.ui.locator(".testrow");
    await row.locator('[name="name"]').fill("糖果配对");
    await row
      .locator('[name="prompt"]')
      .fill("苹果味 桃子味 西瓜味\n圆形 7 9 8\n五角星形 7 6 4");
    await row.locator('[name="answers"]').fill("21个\n21");
    await b.ui.getByRole("button", { name: "保存配置", exact: true }).click();
    try {
      await b.ui
        .locator("#overlay.open")
        .waitFor({ state: "hidden", timeout: 3000 });
    } catch (error) {
      throw new Error(
        `Save did not close the editor; saved objects=${(await b.f.api("state")).data.objects.length}; browser: ${b.messages.filter((m) => m.includes("Blocked form")).join(" ")}`,
        { cause: error },
      );
    }
    const state = (await b.f.api("state")).data;
    expect(state.objects).toHaveLength(1);
    expect(state.objects[0].tests[0].answers).toEqual(["21个", "21"]);
    expect(state.objects[0].enabled).toBe(false);
    expect(await b.ui.locator("#toast").textContent()).toBe("配置已保存");
    expect(b.f.calls).toHaveLength(0);
    expect(await b.page.locator("#monitor").getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    mkdirSync(".test-artifacts", { recursive: true });
    await b.page.screenshot({
      path: resolve(".test-artifacts/save-success.png"),
    });
  } finally {
    await b.close();
  }
}, 30000);

test("settings save closes the sandbox editor and reports success", async () => {
  const b = await embedded();
  try {
    await b.ui.getByRole("button", { name: "设置", exact: true }).click();
    await b.ui.locator('[name="retentionDays"]').fill("7");
    await b.ui.getByRole("button", { name: "保存设置", exact: true }).click();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    expect((await b.f.api("state")).data.settings.retentionDays).toBe(7);
    expect(await b.ui.locator("#toast").textContent()).toBe("设置已保存");
    expect(b.messages.filter((m) => m.includes("Blocked form"))).toHaveLength(
      0,
    );
  } finally {
    await b.close();
  }
}, 30000);

test("save errors keep the draft, allow retry, and pending saves cannot create duplicates", async () => {
  const b = await embedded();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  try {
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    await b.ui.locator(".picker summary").click();
    await b.ui
      .getByRole("button", { name: "Model · test/model", exact: true })
      .click();
    const save = b.ui.getByRole("button", { name: "保存配置", exact: true });
    await save.click();
    await b.ui.locator("#formerror:not(:empty)").waitFor();
    expect((await b.f.api("state")).data.objects).toHaveLength(0);
    expect(await b.ui.locator('[name="target"]').inputValue()).toBe(
      "test/model",
    );
    expect(await save.isEnabled()).toBe(true);
    await b.ui.locator('[name="objectName"]').fill("重试后保存");
    let requests = 0;
    const started = b.page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/objects") && request.method() === "POST",
      { timeout: 5000 },
    );
    await b.page.route("**/api/objects", async (route) => {
      if (route.request().method() === "POST") {
        requests++;
        await gate;
      }
      await route.continue();
    });
    await save.evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await started;
    expect(
      await b.ui
        .getByRole("button", { name: "保存中…", exact: true })
        .isDisabled(),
    ).toBe(true);
    release();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    expect(requests).toBe(1);
    expect((await b.f.api("state")).data.objects).toHaveLength(1);
    expect(await b.ui.locator("#toast").textContent()).toBe("配置已保存");
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("Enter saves edits without submitting a native form; multiline answers stay editable", async () => {
  const b = await embedded();
  try {
    const object = await b.f.object();
    // Reload this isolated page to observe an object created through the public API.
    await b.page.reload();
    await b.ui.getByRole("button", { name: "编辑", exact: true }).click();
    await b.ui.locator('[name="answers"]').fill("21");
    await b.ui.locator('[name="answers"]').press("Enter");
    expect(await b.ui.locator("#overlay.open").isVisible()).toBe(true);
    await b.ui.locator('[name="objectName"]').fill("回车保存");
    await b.ui.locator('[name="objectName"]').press("Enter");
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    const objects = (await b.f.api("state")).data.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0].id).toBe(object.id);
    expect(objects[0].name).toBe("回车保存");
    expect(objects[0].version).toBe(2);
    expect(b.messages.filter((m) => m.includes("Blocked form"))).toHaveLength(
      0,
    );
  } finally {
    await b.close();
  }
}, 30000);
