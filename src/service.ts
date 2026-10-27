import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { Store } from "./store.ts";
import { validate, historyKey } from "./config.ts";
import { CodexAccess, type AccessOptions } from "./access.ts";
import { Engine } from "./engine.ts";
import { preview, previewPolicy } from "./content.ts";
import { HTTPError } from "./types.ts";
import { Screenshots } from "./screenshots.ts";
import { fingerprintKey, validateFingerprint } from "./fingerprint.ts";

export interface MonitorOptions {
  directory: string;
  timers?: boolean;
  now?: () => number;
  pageDirectory?: string;
  active?: () => boolean;
  port?: number;
  respectOtherParents?: boolean;
  access?: AccessOptions;
}
export class OtherParentError extends Error {}
export function atomic(file: string, value: string) {
  const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, file);
}
function matches(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function startMonitor(options: MonitorOptions) {
  const now = options.now ?? Date.now;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const lock = join(options.directory, "owner");
  mkdirSync(lock, { recursive: true });
  // The OS listening socket is the ownership lock. Metadata is only a way to
  // request a graceful handover; stale metadata is never recursively deleted.
  const identity = createHash("sha256")
    .update(realpathSync(options.directory).toLowerCase())
    .digest("hex");
  const lease = net.createServer((socket) => socket.destroy());
  const leaseAddress =
    process.platform === "win32"
      ? { path: `\\\\.\\pipe\\magpie-quality-${identity}` }
      : {
          host: "127.0.0.1",
          port: 20000 + (parseInt(identity.slice(0, 8), 16) % 40000),
        };
  let access: CodexAccess;
  let store: Store | undefined;
  let engine: Engine;
  let screenshots: Screenshots | undefined;
  let url = "",
    closing: Promise<void> | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  const json = (res: http.ServerResponse, value: unknown, status = 200) =>
    res
      .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify(value));
  const body = async (req: http.IncomingMessage) => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 512000) throw new HTTPError(413, "请求过大");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      throw new HTTPError(400, "无效 JSON");
    }
  };
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      if (closing) throw new HTTPError(503, "Monitor stopping");
      if (req.headers.host !== new URL(url).host)
        throw new HTTPError(403, "Host denied");
      const origin = req.headers.origin;
      if (origin && origin !== "null" && origin !== url)
        throw new HTTPError(403, "Origin denied");
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      const path = new URL(req.url ?? "/", url).pathname;
      if (req.method === "OPTIONS") {
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
        res.writeHead(204).end();
        return;
      }
      if (path === "/" && req.method === "GET") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader(
          "Content-Security-Policy",
          `default-src 'none'; script-src ${url}; style-src ${url} 'unsafe-inline'; connect-src ${url}; frame-src 'self' about:; img-src data:; form-action 'none'; base-uri 'none'`,
        );
        res.end(readFileSync(new URL("../ui/index.html", import.meta.url)));
        return;
      }
      if (
        [
          "/app.js",
          "/components.js",
          "/i18n.js",
          "/style.css",
          "/fingerprint.js",
          "/fingerprint.css",
          "/fingerprint-i18n.js",
        ].includes(path) &&
        req.method === "GET"
      ) {
        res.setHeader(
          "Content-Type",
          path.endsWith(".js") ? "text/javascript" : "text/css",
        );
        res.end(readFileSync(new URL("../ui" + path, import.meta.url)));
        return;
      }
      if (!matches(req.headers.authorization ?? "", `Bearer ${token}`))
        throw new HTTPError(401, "Unauthorized");
      if (options.active && !options.active() && path !== "/api/retire")
        throw new HTTPError(503, "插件已停用或宿主配置改变");
      if (!store) throw new HTTPError(503, "服务正在启动");
      store.clean(now());
      if (path === "/api/retire" && req.method === "POST") {
        await engine.stop();
        await screenshots?.stop();
        json(res, { stopped: true });
        void close();
        return;
      }
      if (path === "/api/state" && req.method === "GET") {
        const day = new Date(now());
        day.setHours(0, 0, 0, 0);
        json(res, {
          fingerprints: store.fingerprint.objects().map((o) => ({
            ...o,
            rows: o.rows.map((r) => ({
              ...r,
              historyKey: fingerprintKey(o, r),
            })),
          })),
          fingerprintBatches: store.fingerprint.summaries(),
          fingerprintProgress: engine.fingerprintProgress,
          fingerprintCalls: store.fingerprint.callsSince(day.getTime()),
          baselines: store.fingerprint
            .baselines()
            .map(({ distribution, ...b }) => b),
          objects: store.objects().map((object) => ({
            ...object,
            tests: object.tests.map((test) => ({
              ...test,
              historyKey: historyKey(object, test),
            })),
          })),
          records: store.summaries(),
          events: store.events(),
          settings: store.settings(),
          connection: access.snapshot(),
          busy: engine.busy,
          running: engine.running,
          queued: engine.queued,
          error: engine.error,
          now: now(),
        });
        return;
      }
      if (path === "/api/catalog" && req.method === "GET") {
        const result = await access.refresh();
        if (result.catalogError) throw new HTTPError(409, result.catalogError);
        json(res, result);
        return;
      }
      if (path === "/api/objects" && req.method === "POST") {
        const input = await body(req);
        if (input?.type === "fingerprint") {
          const object = validateFingerprint(input);
          access.assertConnected();
          for (const row of object.rows) {
            access.assertSelectable(row.target);
            if (
              !store.fingerprint.baseline(row.baselineId) ||
              store.fingerprint.baseline(row.baselineId)!.archived
            )
              throw new HTTPError(400, "Select an active baseline");
          }
          store.fingerprint.save(object);
          json(res, object, 201);
          return;
        }
        if (input?.type && input.type !== "legacy")
          throw new HTTPError(400, "Invalid monitor type");
        const object = validate(input);
        access.assertConnected();
        access.assertSelectable(object.target);
        store.save(object);
        json(res, object, 201);
        return;
      }
      const baselineRoute = path.match(/^\/api\/baselines(?:\/([^/]+))?$/);
      if (baselineRoute) {
        if (!baselineRoute[1] && req.method === "GET") {
          json(res, store.fingerprint.baselines());
          return;
        }
        if (!baselineRoute[1] && req.method === "POST") {
          const input = await body(req),
            entries = Array.isArray(input) ? input : [input];
          if (!entries.length || entries.length > 50)
            throw new HTTPError(400, "Expected 1–50 baselines");
          // Validate the entire import before writing any entries.
          const { parseBaseline } = await import("./fingerprint.ts");
          entries.forEach((entry) => parseBaseline(entry));
          json(
            res,
            entries.map((entry) => store!.fingerprint.import(entry)),
            201,
          );
          return;
        }
        if (baselineRoute[1] && req.method === "GET") {
          const b = store.fingerprint.baseline(baselineRoute[1]);
          if (!b) throw new HTTPError(404, "Baseline not found");
          json(res, b);
          return;
        }
        if (baselineRoute[1] && req.method === "PUT") {
          const v = await body(req);
          if (typeof v.archived !== "boolean")
            throw new HTTPError(400, "Expected archive flag");
          json(res, store.fingerprint.archive(baselineRoute[1], v.archived));
          return;
        }
      }
      const batchRoute = path.match(
        /^\/api\/fingerprint-batches\/([^/]+)(?:\/(samples))?$/,
      );
      if (batchRoute && req.method === "GET") {
        const b = store.fingerprint.batch(batchRoute[1]);
        if (!b) throw new HTTPError(404, "Batch not found or expired");
        if (batchRoute[2]) {
          const page = Number(
            new URL(req.url!, url).searchParams.get("page") ?? 1,
          );
          if (!Number.isSafeInteger(page) || page < 1)
            throw new HTTPError(400, "Invalid page");
          json(res, store.fingerprint.samplePage(b.id, page));
        } else json(res, b);
        return;
      }
      const objectRoute = path.match(
        /^\/api\/objects\/([^/]+)(?:\/(run|stop))?$/,
      );
      if (objectRoute) {
        let fingerprint = store.fingerprint.object(objectRoute[1]);
        if (fingerprint) {
          if (objectRoute[2] === "run" && req.method === "POST") {
            const v = await body(req);
            if (v.rowId !== undefined && typeof v.rowId !== "string")
              throw new HTTPError(400, "Invalid model row");
            if (v.rowId && !fingerprint.rows.some((r) => r.id === v.rowId))
              throw new HTTPError(404, "Model row not found");
            await engine.enqueue(fingerprint.id, v.rowId);
            json(res, { queued: true }, 202);
            return;
          }
          if (objectRoute[2] === "stop" && req.method === "POST") {
            engine.cancel(fingerprint.id, true);
            json(res, { stopping: true }, 202);
            return;
          }
          if (!objectRoute[2] && req.method === "PUT") {
            const input = await body(req);
            fingerprint = store.fingerprint.object(objectRoute[1]);
            if (!fingerprint) throw new HTTPError(404, "对象不存在");
            const next = validateFingerprint(input, fingerprint);
            for (const row of next.rows) {
              const previous = fingerprint.rows.find((r) => r.id === row.id);
              if (!previous || previous.target !== row.target)
                access.assertSelectable(row.target);
              const baseline = store.fingerprint.baseline(row.baselineId);
              if (
                !baseline ||
                (baseline.archived && previous?.baselineId !== baseline.id)
              )
                throw new HTTPError(400, "Select an active baseline");
            }
            if (next.enabled && !fingerprint.enabled) {
              access.assertConnected();
            }
            if (
              next.enabled &&
              (!fingerprint.enabled ||
                next.intervalMinutes !== fingerprint.intervalMinutes)
            )
              next.nextAt = engine.busy.includes(next.id)
                ? null
                : Math.max(
                    now(),
                    (next.lastFinishedAt ??
                      now() - next.intervalMinutes * 60000) +
                      next.intervalMinutes * 60000,
                  );
            if (!next.enabled) next.nextAt = null;
            store.fingerprint.save(next);
            json(res, next);
            return;
          }
          if (!objectRoute[2] && req.method === "DELETE") {
            engine.cancel(fingerprint.id, true);
            store.fingerprint.remove(fingerprint.id);
            json(res, { deleted: true });
            return;
          }
          throw new HTTPError(405, "Method not allowed");
        }
        const old = store.object(objectRoute[1]);
        if (!old) throw new HTTPError(404, "对象不存在");
        if (objectRoute[2] === "run" && req.method === "POST") {
          const v = await body(req);
          await engine.enqueue(old.id, v.testId);
          json(res, { queued: true }, 202);
          return;
        }
        if (req.method === "PUT" && !objectRoute[2]) {
          const input = await body(req);
          if (input?.type === "fingerprint")
            throw new HTTPError(400, "Monitor type cannot be changed");
          const object = validate(input, old);
          if (object.target !== old.target)
            access.assertSelectable(object.target);
          if (
            object.target !== old.target ||
            old.needsConversion ||
            (object.enabled && !old.enabled)
          ) {
            access.assertConnected();
          }
          if (!object.enabled && old.enabled) engine.cancel(old.id);
          if (object.enabled && !old.enabled) object.nextAt = now();
          if (!object.enabled) object.nextAt = null;
          store.save(object);
          json(res, object);
          return;
        }
        if (req.method === "DELETE" && !objectRoute[2]) {
          engine.cancel(old.id, true);
          store.remove(old.id);
          json(res, { deleted: true });
          return;
        }
      }
      const recordRoute = path.match(/^\/api\/records\/([^/]+)$/);
      if (recordRoute && req.method === "GET") {
        const r = store.record(recordRoute[1]);
        if (!r) throw new HTTPError(404, "记录不存在或已清理");
        json(res, r);
        return;
      }
      const galleryRoute = path.match(/^\/api\/gallery\/([^/]+)$/);
      if (galleryRoute && req.method === "GET") {
        const page = Number(
          new URL(req.url!, url).searchParams.get("page") ?? 1,
        );
        if (!Number.isSafeInteger(page) || page < 1)
          throw new HTTPError(400, "无效页码");
        const result = store.gallery(galleryRoute[1], page);
        json(res, {
          ...result,
          items: result.items.map((r) => ({
            id: r.id,
            at: r.at,
            finishedAt: r.finishedAt,
            version: r.snapshot.version,
            backend: r.backend ?? r.snapshot.backend ?? "direct-gateway",
            preview: preview(r.artifact!),
          })),
        });
        return;
      }
      const previewRoute = path.match(/^\/api\/preview\/([^/]+)$/);
      if (previewRoute && req.method === "GET") {
        const r = store.record(previewRoute[1]);
        if (!r?.artifact) throw new HTTPError(404, "作品不存在");
        json(res, { html: preview(r.artifact), policy: previewPolicy });
        return;
      }
      const thumbnailRoute = path.match(/^\/api\/thumbnail\/([^/]+)$/);
      if (thumbnailRoute && ["GET", "POST"].includes(req.method ?? "")) {
        if (!store.record(thumbnailRoute[1])?.artifact)
          throw new HTTPError(404, "作品不存在");
        const value = await screenshots!.request(
          thumbnailRoute[1],
          req.method === "POST",
        );
        if (closing) throw new HTTPError(503, "Monitor stopping");
        if (!store.record(thumbnailRoute[1])?.artifact)
          throw new HTTPError(404, "作品不存在");
        const { png, ...metadata } = value;
        json(res, {
          ...metadata,
          ...(png
            ? {
                dataURL:
                  "data:image/png;base64," +
                  Buffer.from(png).toString("base64"),
              }
            : {}),
        });
        return;
      }
      if (path === "/api/settings" && req.method === "PUT") {
        const v = await body(req);
        if (
          !Number.isInteger(v.retentionDays) ||
          v.retentionDays < 1 ||
          v.retentionDays > 365
        )
          throw new HTTPError(400, "保留期须为 1–365 天");
        const fingerprintRetentionDays =
          v.fingerprintRetentionDays ??
          store.settings().fingerprintRetentionDays ??
          30;
        if (
          !Number.isInteger(fingerprintRetentionDays) ||
          fingerprintRetentionDays < 1 ||
          fingerprintRetentionDays > 365
        )
          throw new HTTPError(400, "Fingerprint retention must be 1–365 days");
        const codexPath = v.codexPath ?? store.settings().codexPath ?? "";
        if (
          typeof codexPath !== "string" ||
          codexPath.length > 2048 ||
          (codexPath !== "" && !isAbsolute(codexPath)) ||
          /[\r\n\0]/.test(codexPath)
        )
          throw new HTTPError(
            400,
            "Codex path must be an absolute executable path, not a command line",
          );
        const browserPath = v.browserPath ?? store.settings().browserPath ?? "";
        const magpiePath = v.magpiePath ?? store.settings().magpiePath ?? "";
        if (
          typeof magpiePath !== "string" ||
          magpiePath.length > 2048 ||
          (magpiePath !== "" && !isAbsolute(magpiePath)) ||
          /[\r\n\0]/.test(magpiePath)
        )
          throw new HTTPError(
            400,
            "Magpie path must be an absolute executable path",
          );
        if (
          typeof browserPath !== "string" ||
          browserPath.length > 2048 ||
          (browserPath !== "" && !isAbsolute(browserPath)) ||
          /[\r\n\0]/.test(browserPath)
        )
          throw new HTTPError(
            400,
            "Browser path must be an absolute executable path, not a command line",
          );
        store.setSettings({
          retentionDays: v.retentionDays,
          fingerprintRetentionDays,
          codexPath,
          magpiePath,
          browserPath,
        });
        store.clean(now());
        json(res, store.settings());
        return;
      }
      if (path === "/api/export" && req.method === "GET") {
        json(res, {
          format: 1,
          exportedAt: now(),
          objects: store.objects(),
          settings: store.settings(),
          records: store.records(),
          events: store.events(),
          fingerprints: store.fingerprint.objects(),
          baselines: store.fingerprint.baselines(),
          fingerprintBatches: store.fingerprint
            .batches()
            .map((b) => ({ ...b, samples: store!.fingerprint.samples(b.id) })),
        });
        return;
      }
      throw new HTTPError(404, "Not found");
    } catch (e) {
      if (!res.headersSent)
        json(
          res,
          {
            error:
              e instanceof HTTPError
                ? e.message
                : "操作失败；请检查存储或重启插件",
          },
          e instanceof HTTPError ? e.status : 500,
        );
      else res.end();
    }
  });
  const close = () =>
    (closing ??= (async () => {
      if (timer) clearInterval(timer);
      if (engine) await engine.stop();
      await access?.close();
      await screenshots?.stop();
      store?.close();
      try {
        const own = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        if (own.token === token) rmSync(join(lock, "owner.json"));
      } catch {}
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
      if (lease.listening)
        await new Promise<void>((r) => lease.close(() => r()));
    })());
  try {
    const deadline = Date.now() + 8000;
    while (true) {
      try {
        await new Promise<void>((done, reject) => {
          const cleanup = () => {
            lease.off("error", onError);
            lease.off("listening", onListen);
          };
          const onError = (e: Error) => {
            cleanup();
            reject(e);
          };
          const onListen = () => {
            cleanup();
            done();
          };
          lease.once("error", onError);
          lease.once("listening", onListen);
          lease.listen({ ...leaseAddress, exclusive: true });
        });
        break;
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EADDRINUSE" ||
          Date.now() > deadline
        )
          throw error;
        let owner;
        try {
          owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
        } catch {}
        if (
          options.respectOtherParents &&
          owner?.parentPid &&
          owner.parentPid !== process.ppid
        ) {
          let alive = false;
          try {
            process.kill(owner.parentPid, 0);
            alive = true;
          } catch {}
          if (alive)
            throw new OtherParentError(
              "A living Magpie process already owns this monitor",
            );
        }
        try {
          if (owner && new URL(owner.url).hostname === "127.0.0.1")
            await fetch(owner.url + "/api/retire", {
              method: "POST",
              headers: { Authorization: `Bearer ${owner.token}` },
              signal: AbortSignal.timeout(2000),
              redirect: "error",
            });
        } catch {}
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        done();
      });
    });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    store = new Store(options.directory, now());
    access = new CodexAccess(() => store!.settings(), now, options.access);
    screenshots = new Screenshots(store);
    engine = new Engine(store, access, now, options.active, (id) => {
      try {
        void screenshots!.request(id).catch(() => {});
      } catch {}
    });
    atomic(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, parentPid: process.ppid, url, token }),
    );
    if (options.pageDirectory) {
      mkdirSync(options.pageDirectory, { recursive: true });
      atomic(
        join(options.pageDirectory, "index.html"),
        `<!doctype html><meta charset="utf-8"><body data-monitor-url="${url}/#${token}"><p>正在打开Codex降智检测…</p><script src="launch.js"></script>`,
      );
    }
    if (options.timers !== false)
      timer = setInterval(() => {
        if (options.active && !options.active()) {
          void close();
          return;
        }
        try {
          void engine.tick().catch(() => {
            engine.error = "存储或调度不可读取，请重启插件；未继续执行。";
          });
        } catch {
          engine.error = "存储或调度不可读取，请重启插件；未继续执行。";
        }
      }, 1000);
    return {
      url,
      token,
      close,
      tick: () => engine.tick(),
      idle: () => engine.idle(),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
