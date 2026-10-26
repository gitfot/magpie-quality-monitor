import { test, expect } from "bun:test";
import { join } from "node:path";
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
    ).toBe(true);
  } finally {
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
