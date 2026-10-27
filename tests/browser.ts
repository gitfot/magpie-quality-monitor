import http from "node:http";
import { randomInt } from "node:crypto";
import { chromium } from "playwright";
import { fixture } from "./fixture.ts";

export async function embedded(reply?: Parameters<typeof fixture>[0]) {
  const f = await fixture(reply);
  // Bun can assign low ports that Chromium reserves (for example 1719).
  // Bind test listeners to explicit high ports, without weakening browser security.
  const host = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><meta charset="utf-8"><iframe id="monitor" sandbox="allow-scripts" style="width:100%;height:95vh;border:0" src="${f.app.url}/#${f.app.token}"></iframe><script>addEventListener('message',e=>{const frame=document.getElementById('monitor');if(e.source===frame.contentWindow&&e.data?.method==='hello')e.source.postMessage({magpie:1,id:e.data.id,result:{lang:'zh',dark:false}},'*')})</script>`,
    );
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (let attempt = 0; Number(new URL(f.app.url).port) < 20000; attempt++) {
      if (attempt === 20) throw Error("No browser-safe fixture port available");
      try {
        await f.restart(randomInt(20000, 60000));
      } catch (error) {
        if (
          !["EADDRINUSE", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    for (let attempt = 0; ; attempt++) {
      if (attempt === 20) throw Error("No browser-safe host port available");
      try {
        await new Promise<void>((done, reject) => {
          const cleanup = () => {
            host.off("error", onError);
            host.off("listening", onListen);
          };
          const onError = (error: Error) => {
            cleanup();
            reject(error);
          };
          const onListen = () => {
            cleanup();
            done();
          };
          host.once("error", onError);
          host.once("listening", onListen);
          host.listen(randomInt(20000, 60000), "127.0.0.1");
        });
        break;
      } catch (error) {
        if (
          !["EADDRINUSE", "EACCES"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
    browser = await chromium.launch({
      channel: process.env.MAGPIE_BROWSER_CHANNEL || "chrome",
      headless: true,
      timeout: 10000,
    });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    page.setDefaultTimeout(10000);
    await page.route("**/*", (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    const messages: string[] = [];
    page.on("console", (message) =>
      messages.push(message.text().replaceAll(f.app.token, "<REDACTED>")),
    );
    await page.goto(
      `http://127.0.0.1:${(host.address() as { port: number }).port}`,
    );
    const ui = page.frameLocator("#monitor");
    await ui
      .getByRole("button", { name: "＋ 新建监测对象", exact: true })
      .waitFor();
    await ui.locator('[data-action="refresh-catalog"]:enabled').waitFor();
    return {
      f,
      page,
      ui,
      messages,
      close: async () => {
        await browser!.close();
        host.closeAllConnections();
        await new Promise<void>((r) => host.close(() => r()));
        await f.close();
      },
    };
  } catch (error) {
    await browser?.close();
    host.closeAllConnections();
    await new Promise<void>((r) => host.close(() => r()));
    await f.close();
    throw error;
  }
}
