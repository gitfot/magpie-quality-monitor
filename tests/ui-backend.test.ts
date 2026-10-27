import { test, expect } from "bun:test";
import { embedded } from "./browser.ts";
import { writeFileSync } from "node:fs";

test("CLI is the only backend, models are catalog-only and unknown native access leaves history readable", async () => {
  const b = await embedded();
  try {
    await b.ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .click();
    await b.ui.locator('[data-action="fp-new-legacy"]').click();
    expect(await b.ui.locator('[name="backend"]').inputValue()).toBe(
      "codex-cli",
    );
    expect(await b.ui.locator('[data-action="pick-backend"]').count()).toBe(0);
    expect(await b.ui.locator('[name="target"]').getAttribute("type")).toBe(
      "hidden",
    );
    await b.ui.locator(".picker summary").click();
    await b.ui.locator('[data-action="pick-model"]').first().waitFor();
    expect(await b.ui.locator('[data-action="pick-model"]').count()).toBe(3);
    await b.ui
      .getByRole("button", { name: "Model · test/model", exact: true })
      .click();
    await b.ui.locator('[name="objectName"]').fill("Codex monitor");
    await b.ui.getByRole("button", { name: "保存配置", exact: true }).click();
    await b.ui.locator("#overlay.open").waitFor({ state: "hidden" });
    writeFileSync(b.f.connectionFile, "{}");
    await b.page.reload();
    await b.ui.getByRole("button", { name: "历史", exact: true }).click();
    expect(await b.ui.locator("#dialog").innerText()).toContain("暂无记录");
    expect(await b.ui.locator("h1").innerText()).toBe("Codex降智检测");
  } finally {
    await b.close();
  }
}, 30000);
