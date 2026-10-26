import { test, expect } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright";
import { embedded } from "./browser.ts";
import { fixture } from "./fixture.ts";

// Repository-authored synthetic SVG; no user-supplied artwork or live desktop data.
const artwork = readFileSync(
  join(import.meta.dir, "fixtures", "synthetic-artwork.html"),
  "utf8",
);

test("stored SVG artwork keeps local instances, geometry animation and inherited paint across previews", async () => {
  const f = await fixture(() => ({ text: artwork }));
  try {
    const object = await f.object({
      tests: [{ kind: "drawing", name: "Fixture artwork", prompt: "Draw" }],
    });
    await f.api(`objects/${object.id}/run`, "POST", {});
    await f.app.idle();
    const id = (await f.api("state")).data.records[0].id;
    await f.restart();
    const html = (await f.api(`preview/${id}`)).data.html;
    expect(html.match(/<use\b/g) ?? []).toHaveLength(11);
    expect(html.match(/<animate\b/g) ?? []).toHaveLength(2);
    expect(html.match(/\bstroke-width=/g)).toHaveLength(8);
    expect(html.match(/\bstroke-linecap=/g)).toHaveLength(4);
    expect(html).toContain('filter="url(#shadow)"');
    expect(html).toContain('href="#wheelArtwork"');
    expect((await f.api(`records/${id}`)).data.raw).toBe(artwork);
    const gallery = (await f.api(`gallery/${object.tests[0].id}`)).data;
    expect(gallery.items[0].preview).toBe(html);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

async function freeze(art: Locator) {
  await art.scrollIntoViewIfNeeded();
  await art
    .contentFrame()
    .locator("svg")
    .evaluate((element) => {
      const svg = element as SVGSVGElement;
      svg.pauseAnimations();
      svg.setCurrentTime(0.375);
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = 375;
      }
    });
  // Capture the nested frame after its post-scroll animation paint, not stale pixels.
  await art.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

test("the synthetic artwork renders like its original HTML in the empty preview sandbox", async () => {
  const b = await embedded(() => ({ text: artwork }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  try {
    const object = await b.f.object({
      tests: [{ kind: "drawing", name: "Fixture artwork", prompt: "Draw" }],
    });
    await b.f.api(`objects/${object.id}/run`, "POST", {});
    await b.f.app.idle();
    await b.ui
      .locator('[data-action="refresh-catalog"]:not(:disabled)')
      .waitFor();
    await b.page.route("**/api/catalog", async (route) => {
      await gate;
      await route.continue();
    });
    await b.page.reload();
    await b.ui
      .locator('[data-action="refresh-catalog"][aria-busy="true"]')
      .waitFor();
    const thumbnail = b.ui.locator(".card .artstage img.thumbnail");
    await thumbnail.waitFor();
    expect(
      await thumbnail.evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
    ).toBeGreaterThan(0);
    await b.ui.getByRole("button", { name: "放大 ↗", exact: true }).click();
    await b.ui.locator(".raw-preview summary").click();
    const art = b.ui.locator("#largepreview iframe.preview");
    await art.waitFor();
    // Integral dimensions keep vh/subpixel rasterization out of the SVG comparison.
    await art.evaluate((el) => {
      (el as HTMLElement).style.width = "900px";
      (el as HTMLElement).style.height = "520px";
    });
    const svg = art.contentFrame().locator("svg");
    await svg.waitFor();
    expect(await svg.locator('use[href="#wheelArtwork"]').count()).toBe(2);
    expect(await svg.locator('animate[attributeName="d"]').count()).toBe(2);
    expect(await art.getAttribute("sandbox")).toBe("");
    await freeze(art);
    mkdirSync(".test-artifacts", { recursive: true });
    const rendered = await art.screenshot({
      path: ".test-artifacts/artwork-preview.png",
    });
    const frame = await art.elementHandle();
    release();
    await b.ui
      .locator('[data-action="refresh-catalog"][aria-busy="false"]')
      .waitFor();
    expect(await art.evaluate((el, old) => el === old, frame)).toBe(true);
    // Same iframe, viewport and animation time; change only cleaned vs original HTML.
    await art.evaluate((element, html) => {
      (element as HTMLIFrameElement).srcdoc =
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'\">" +
        html;
    }, artwork);
    await svg
      .locator('use[href="#wheelArtwork"]')
      .first()
      .waitFor({ state: "attached" });
    await freeze(art);
    const original = await art.screenshot({
      path: ".test-artifacts/artwork-original.png",
    });
    expect(rendered.equals(original)).toBe(true);
    await b.ui.getByRole("button", { name: "关闭", exact: true }).click();
    await b.ui.getByRole("button", { name: "放大 ↗", exact: true }).click();
    await b.ui.locator(".raw-preview summary").click();
    const large = b.ui.locator("#largepreview iframe.preview");
    await large.contentFrame().locator("svg").waitFor();
    expect(
      await large.contentFrame().locator('use[href="#wheelArtwork"]').count(),
    ).toBe(2);
    expect(await large.getAttribute("sandbox")).toBe("");
    await freeze(large);
    await large.screenshot({
      path: ".test-artifacts/artwork-preview-large.png",
    });
    await b.ui.getByRole("button", { name: "关闭", exact: true }).click();
    await b.ui.getByRole("button", { name: "历史图片 ↗", exact: true }).click();
    const gallery = b.ui.locator(".gallery img.thumbnail").first();
    await gallery.waitFor();
    expect(await gallery.getAttribute("src")).toBe(
      await thumbnail.getAttribute("src"),
    );
    expect(await b.ui.locator(".gallery iframe").count()).toBe(0);
  } finally {
    release();
    await b.close();
  }
}, 30000);

test("SVG references and animation cannot add external loads, scripts or mutable navigation", async () => {
  const hostile = `<html><body><svg xmlns:xlink="http://www.w3.org/1999/xlink">
    <defs><circle id="safe" r="10"/></defs>
    <use id="good" href="#safe"/><use id="legacy" xlink:href="#safe"/>
    <use href="https://evil.example/art.svg#safe"/><use xlink:href="//evil.example/a.svg#x"/>
    <use href="other.svg#safe"/><use href="data:image/svg+xml,evil"/>
    <use href="javascript:alert(1)"/><use href="&#10;//evil.example/a"/>
    <circle filter="url(https://evil.example/filter.svg#x)" clip-path="url(other.svg#clip)"/>
    <animate attributeName="href" values="#safe;https://evil.example"/>
    <animate attributeName="xlink:href" to="javascript:alert(1)"/>
    <animate attributeName="style" to="background:url(https://evil.example)"/>
    <animate attributeName="onload" to="alert(1)"/>
    <animate attributeName="fill" values="red;url(https://evil.example)"/>
    <animate attributeName="d" href="https://evil.example/x" dur="1s" values="M0 0;M1 1" onbegin="alert(1)"/>
    <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="1s" repeatCount="indefinite"/>
    <script>parent.pwned=1</script><foreignObject><iframe src="https://evil.example"/></foreignObject>
  </svg></body></html>`;
  const b = await embedded(() => ({ text: hostile }));
  try {
    const external: string[] = [];
    b.page.on("request", (request) => {
      if (new URL(request.url()).hostname !== "127.0.0.1")
        external.push(request.url());
    });
    const object = await b.f.object({
      tests: [{ kind: "drawing", name: "Hostile", prompt: "Draw" }],
    });
    await b.f.api(`objects/${object.id}/run`, "POST", {});
    await b.f.app.idle();
    const id = (await b.f.api("state")).data.records[0].id;
    const html = (await b.f.api(`preview/${id}`)).data.html;
    for (const forbidden of [
      "evil.example",
      "javascript:",
      "<script",
      "<iframe",
      "<foreignObject",
      "onbegin=",
      'attributeName="href"',
      'attributeName="style"',
    ])
      expect(html).not.toContain(forbidden);
    await b.page.reload();
    await b.ui.getByRole("button", { name: "放大 ↗", exact: true }).click();
    await b.ui.locator(".raw-preview summary").click();
    const art = b.ui.locator("#largepreview iframe.preview");
    const svg = art.contentFrame().locator("svg");
    await svg.waitFor();
    expect(await svg.locator("use[href]").count()).toBe(1);
    expect(await svg.locator("#legacy").getAttribute("xlink:href")).toBe(
      "#safe",
    );
    expect(await svg.locator("animate").count()).toBe(1);
    expect(await svg.locator("animateTransform").count()).toBe(1);
    expect(await art.getAttribute("sandbox")).toBe("");
    expect(external).toHaveLength(0);
  } finally {
    await b.close();
  }
}, 30000);
