import { test, expect } from "bun:test";
import { randomInt } from "node:crypto";
import { embedded } from "./browser.ts";

async function freeze(b: Awaited<ReturnType<typeof embedded>>) {
  await b.page.clock.install();
  await b.page.clock.pauseAt(new Date(Date.now() + 1000));
}

async function poll(b: Awaited<ReturnType<typeof embedded>>, rounds = 1) {
  // Step every interval so the idle-poll counter advances without real waits.
  for (let tick = 0; tick < rounds * 5; tick++)
    await b.page.clock.fastForward(1000);
}

async function restart(
  b: Awaited<ReturnType<typeof embedded>>,
  samePort = false,
) {
  const oldPort = Number(new URL(b.f.app.url).port);
  for (let attempt = 0; ; attempt++) {
    const port = samePort ? oldPort : randomInt(20000, 60000);
    if (!samePort && port === oldPort) continue;
    try {
      await b.f.restart(port);
      return;
    } catch (error) {
      if (
        samePort ||
        attempt >= 20 ||
        !["EADDRINUSE", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
}

async function connected(b: Awaited<ReturnType<typeof embedded>>) {
  await b.ui.locator("h1").waitFor();
  await b.ui.locator("#connection-error").waitFor({ state: "detached" });
  expect(
    b.page.frames().some((frame) => frame.url() === b.f.app.url + "/"),
  ).toBe(true);
  expect(await b.page.evaluate(() => (window as any).pluginErrors)).toEqual([]);
}

for (const samePort of [false, true]) {
  test(`one reconnect restores a restarted service with ${samePort ? "a new session" : "a new port"} without reporting a page crash`, async () => {
    const b = await embedded(undefined, { entry: true });
    try {
      await freeze(b);
      const oldToken = b.f.app.token;
      await restart(b, samePort);
      expect(b.f.app.token === oldToken).toBe(false);
      await poll(b);
      await b.ui.locator("#connection-error").waitFor();
      const restored = b.page.waitForRequest(
        (request) =>
          request.url() === b.f.app.url + "/api/state" &&
          request.headers().authorization === "Bearer " + b.f.app.token,
      );
      const entryRequest = b.page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/index.html"),
      );
      await b.ui.locator('[data-action="reopen"]').click();
      const requestURL = new URL((await entryRequest).url());
      expect(requestURL.searchParams.has("reconnect")).toBe(true);
      expect(requestURL.search.includes(b.f.app.token)).toBe(false);
      expect(requestURL.search.includes(oldToken)).toBe(false);
      await restored;
      await connected(b);
      expect(b.f.calls).toHaveLength(0);
    } finally {
      await b.close();
    }
  }, 30000);
}

test("consecutive failed polls return through the stable entry automatically", async () => {
  const b = await embedded(undefined, { entry: true });
  try {
    const object = await b.f.object();
    await b.page.reload();
    await b.ui.locator(".cardhead").waitFor();
    await freeze(b);
    await restart(b);
    const restored = b.page.waitForRequest(
      (request) => request.url() === b.f.app.url + "/api/state",
    );
    await poll(b);
    await b.ui.locator("#connection-error").waitFor();
    await poll(b);
    await restored;
    await connected(b);
    expect(await b.ui.locator(".cardhead").innerText()).toContain(object.name);
    expect(b.f.calls).toHaveLength(0);
  } finally {
    await b.close();
  }
}, 30000);

test("transient failures recover in place and unsaved forms prevent automatic navigation", async () => {
  const b = await embedded(undefined, { entry: true });
  try {
    await freeze(b);
    let failing = true;
    await b.page.route("**/api/state", (route) =>
      failing ? route.abort("failed") : route.continue(),
    );
    await poll(b);
    await b.ui.locator("#connection-error").waitFor();
    failing = false;
    await poll(b);
    await connected(b);
    await b.ui.locator('[data-action="edit"]').click();
    await b.ui.locator('[name="objectName"]').fill("Unsaved monitor");
    await restart(b);
    await poll(b);
    await b.ui.locator("#connection-error").waitFor();
    await poll(b, 2);
    expect(await b.ui.locator('[name="objectName"]').inputValue()).toBe(
      "Unsaved monitor",
    );
    expect(await b.ui.locator("#overlay.open").count()).toBe(1);
    await b.ui.locator('[data-action="close"]').click();
    const restored = b.page.waitForRequest(
      (request) => request.url() === b.f.app.url + "/api/state",
    );
    await poll(b);
    await restored;
    await connected(b);
  } finally {
    await b.close();
  }
}, 30000);

test("legacy direct pages retry in place instead of sending a host error", async () => {
  const b = await embedded();
  try {
    await freeze(b);
    await b.page.route("**/api/state", (route) => route.abort("failed"));
    await poll(b);
    await b.ui.locator("#connection-error").waitFor();
    await b.page.unroute("**/api/state");
    await b.ui.locator('[data-action="reopen"]').click();
    await connected(b);
  } finally {
    await b.close();
  }
}, 30000);

test("a fragment cannot redirect reconnects away from the real parent's plugin entry", async () => {
  const b = await embedded();
  try {
    await freeze(b);
    const redirects: string[] = [];
    b.page.on("request", (request) => {
      if (request.isNavigationRequest()) redirects.push(request.url());
    });
    const host = new URL(b.page.url()).origin;
    for (const entry of [
      "https://untrusted.example/_magpie/plugin/" +
        "0".repeat(32) +
        "/index.html",
      host + "/api/settings",
      host + "/_magpie/plugin/" + "0".repeat(32) + "/index.html?untrusted=1",
    ]) {
      const loaded = b.page.waitForRequest(
        (request) => request.url() === b.f.app.url + "/api/state",
      );
      await b.page.locator("#monitor").evaluate(
        (frame, url) => {
          (frame as HTMLIFrameElement).src = url;
        },
        b.f.app.url +
          "/#" +
          new URLSearchParams({ token: b.f.app.token, entry }),
      );
      await loaded;
      await b.ui.locator("h1").waitFor();
      await b.page.route("**/api/state", (route) => route.abort("failed"));
      await poll(b);
      await b.ui.locator("#connection-error").waitFor();
      await b.ui.locator('[data-action="reopen"]').click();
      await b.page.unroute("**/api/state");
    }
    expect(redirects.every((url) => url === b.f.app.url + "/")).toBe(true);
    expect(await b.page.evaluate(() => (window as any).pluginErrors)).toEqual(
      [],
    );
  } finally {
    await b.close();
  }
}, 45000);

test("automatic entry reloads are bounded when fresh authorizations keep being rejected", async () => {
  const b = await embedded(undefined, { entry: true });
  try {
    await freeze(b);
    let entries = 0;
    b.page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/index.html")) entries++;
    });
    await b.page.route("**/api/state", (route) =>
      route.fulfill({
        status: 401,
        json: { error: "Unauthorized" },
      }),
    );
    await poll(b);
    await b.ui.locator("#connection-error").waitFor();
    for (const count of [1, 2]) {
      const entry = b.page.waitForRequest((request) =>
        new URL(request.url()).pathname.endsWith("/index.html"),
      );
      const loaded = b.page.waitForRequest(
        (request) => request.url() === b.f.app.url + "/app.js",
      );
      await poll(b);
      await entry;
      await loaded;
      await b.ui.locator("#connection-error").waitFor();
      expect(entries).toBe(count);
    }
    await poll(b, 3);
    expect(entries).toBe(2);
    expect(await b.page.evaluate(() => (window as any).pluginErrors)).toEqual(
      [],
    );
  } finally {
    await b.close();
  }
}, 30000);
