import type { Browser } from "playwright-core";
import { Store } from "./store.ts";
import { preview } from "./content.ts";
import type { Thumbnail } from "./types.ts";

const rendererVersion = "full-page-v2-settled-3s";

// Derived presentation only: no model credentials, verdicts or execution timing.
export class Screenshots {
  private queue: {
    id: string;
    path: string;
    key: string;
    done: (value: Thumbnail) => void;
  }[] = [];
  private pending = new Map<string, Promise<Thumbnail>>();
  private task: Promise<void> | null = null;
  private browser: Browser | null = null;
  private stopped = false;
  constructor(private store: Store) {}

  request(id: string, retry = false): Promise<Thumbnail> {
    if (this.stopped) return Promise.resolve({ error: "stopped" });
    const path = this.store.settings().browserPath ?? "";
    const key = rendererVersion + ":" + path;
    const pendingKey = id + ":" + key;
    const pending = this.pending.get(pendingKey);
    if (pending) return pending;
    if (retry) this.store.forgetThumbnail(id);
    const cached = this.store.thumbnail(id, key);
    if (cached) return Promise.resolve(cached);
    if (this.pending.size >= 32) return Promise.resolve({ error: "busy" });
    const result = new Promise<Thumbnail>((done) =>
      this.queue.push({ id, path, key, done }),
    );
    this.pending.set(pendingKey, result);
    if (!this.task) this.task = Promise.resolve().then(() => this.drain());
    return result;
  }

  private async drain() {
    try {
      while (this.queue.length && !this.stopped) {
        const job = this.queue.shift()!;
        let result: Thumbnail = { error: "render" };
        try {
          const record = this.store.record(job.id);
          if (record?.artifact)
            result = await this.render(record.artifact, job.path);
          if (!this.stopped) this.store.saveThumbnail(job.id, job.key, result);
        } catch {
          // Storage/render failures never stop model monitoring or leak paths.
        } finally {
          this.pending.delete(job.id + ":" + job.key);
          job.done(result);
        }
      }
    } finally {
      for (const job of this.queue) job.done({ error: "stopped" });
      this.queue = [];
      this.pending.clear();
      this.task = null;
    }
  }

  private async render(html: string, path: string): Promise<Thumbnail> {
    let expired = false;
    const deadline = Date.now() + 15000;
    const timer = setTimeout(() => {
      expired = true;
      void this.browser?.close().catch(() => {});
    }, 15000);
    try {
      const { chromium } = await import("playwright-core");
      const candidates = path
        ? [{ executablePath: path }]
        : [{ channel: "chrome" }, { channel: "msedge" }];
      for (const candidate of candidates) {
        if (this.stopped || expired) return { error: "stopped" };
        try {
          this.browser = await chromium.launch({
            ...candidate,
            headless: true,
            chromiumSandbox: true,
            timeout: Math.max(1, Math.min(7000, deadline - Date.now())),
            args: [
              "--disable-background-networking",
              "--disable-component-update",
              "--no-first-run",
            ],
          });
          break;
        } catch {}
      }
      if (!this.browser) return { error: "browser" };
      if (this.stopped || expired) return { error: "stopped" };
      const context = await this.browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
        javaScriptEnabled: false,
        serviceWorkers: "block",
        permissions: [],
        acceptDownloads: false,
      });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.setContent(
        `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'">${preview(html)}`,
        { timeout: 5000, waitUntil: "load" },
      );
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(3000);
      // Driver evaluation measures layout; generated page JavaScript stays disabled.
      const size = await page.evaluate(() => ({
        width: Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth ?? 0,
          1280,
        ),
        height: Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0,
          800,
        ),
      }));
      const width = Math.min(2048, size.width);
      const height = Math.min(6000, size.height, Math.floor(8000000 / width));
      const png = await page.screenshot({
        type: "png",
        fullPage: true,
        clip: { x: 0, y: 0, width, height },
        timeout: 5000,
        caret: "hide",
      });
      if (png.length > 8 * 1024 * 1024) return { error: "limit" };
      return {
        png,
        width,
        height,
        clipped: width < size.width || height < size.height,
      };
    } catch {
      return { error: this.stopped ? "stopped" : "render" };
    } finally {
      clearTimeout(timer);
      await this.browser?.close().catch(() => {});
      this.browser = null;
    }
  }

  async stop() {
    this.stopped = true;
    await this.browser?.close().catch(() => {});
    await this.task;
  }
}
