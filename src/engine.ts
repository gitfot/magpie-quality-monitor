import { randomUUID } from "node:crypto";
import { Store } from "./store.ts";
import { redact } from "./connection.ts";
import {
  grade,
  extract,
  answerInstruction,
  drawingInstruction,
} from "./content.ts";
import { HTTPError, type Execution, type MonitorObject } from "./types.ts";
import { codexArgs, runCodex } from "./codex.ts";
import { CodexAccess } from "./access.ts";

export class Engine {
  private queue: {
    snapshot: MonitorObject;
    testId?: string;
    generation: number;
  }[] = [];
  private pending = new Set<string>();
  private generations = new Map<string, number>();
  private task: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private ticking = false;
  private current: string | null = null;
  error: string | null = null;
  constructor(
    private store: Store,
    private access: CodexAccess,
    private now: () => number,
    private active: () => boolean = () => true,
    private artworkReady: (id: string) => void = () => {},
  ) {}
  get busy() {
    return [...this.pending];
  }
  get running() {
    return this.current;
  }
  get queued() {
    return this.busy.filter((id) => id !== this.running);
  }
  cancel(id: string, abort = false) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    if (this.current !== id) {
      this.queue = this.queue.filter((round) => round.snapshot.id !== id);
      this.pending.delete(id);
    }
    if (abort && this.current === id) this.controller?.abort();
  }
  async enqueue(id: string, testId?: string) {
    if (this.stopped || this.error || !this.active())
      throw new HTTPError(503, "调度器不可用");
    const snapshot = this.store.object(id);
    if (!snapshot) throw new HTTPError(404, "对象不存在");
    if (snapshot.backend !== "codex-cli" || snapshot.needsConversion)
      throw new HTTPError(409, "旧直连对象待确认转为 Codex CLI；历史仍保留");
    this.access.assertConnected();
    if (this.stopped || !this.active())
      throw new HTTPError(503, "调度器不可用");
    if (this.pending.has(id))
      throw new HTTPError(409, "此对象已有执行中的轮次");
    if (testId && !snapshot.tests.some((t) => t.id === testId))
      throw new HTTPError(404, "测试项不存在");
    this.pending.add(id);
    this.queue.push({
      snapshot,
      testId,
      generation: this.generations.get(id) ?? 0,
    });
    if (!this.task) this.task = Promise.resolve().then(() => this.drain());
  }
  async tick() {
    if (this.ticking || this.stopped || this.error || !this.active()) return;
    this.ticking = true;
    try {
      this.store.clean(this.now());
      if (
        !this.store
          .objects()
          .some(
            (o) =>
              o.enabled &&
              o.backend === "codex-cli" &&
              o.nextAt !== null &&
              o.nextAt <= this.now(),
          )
      )
        return;
      if (this.stopped || !this.active()) return;
      for (const object of this.store.objects()) {
        if (
          !object.enabled ||
          object.backend !== "codex-cli" ||
          object.needsConversion ||
          object.nextAt === null ||
          object.nextAt > this.now()
        )
          continue;
        try {
          this.access.assertConnected();
        } catch {
          continue;
        }
        if (this.pending.has(object.id))
          this.event(object.id, "skipped", "上轮未完成，跳过本轮");
        else {
          if (object.nextAt < this.now() - 60000)
            this.event(object.id, "gap", "监测空档；错过的轮次不补跑");
          await this.enqueue(object.id);
        }
        object.nextAt = this.now() + object.intervalMinutes * 60000;
        this.store.save(object);
      }
    } finally {
      this.ticking = false;
    }
  }
  private event(id: string, type: string, message: string) {
    this.store.event({
      id: randomUUID(),
      objectId: id,
      at: this.now(),
      type,
      message,
    });
  }
  private async drain() {
    try {
      while (this.queue.length && !this.stopped) {
        const round = this.queue.shift()!;
        try {
          for (const test of round.snapshot.tests.filter((t) =>
            round.testId ? t.id === round.testId : t.enabled,
          )) {
            if (
              this.stopped ||
              !this.active() ||
              !this.store.object(round.snapshot.id) ||
              (this.generations.get(round.snapshot.id) ?? 0) !==
                round.generation
            )
              break;
            try {
              this.access.assertConnected();
            } catch {
              this.event(
                round.snapshot.id,
                "disconnected",
                "Codex 本地接入配置不可用，停止后续测试",
              );
              break;
            }
            const prompt =
              test.prompt +
              (test.kind === "logic" ? answerInstruction : drawingInstruction) +
              `\n\n输出 token 上限为 ${test.maxTokens}（提示要求，非协议硬上限）。`;
            const args = codexArgs(
              round.snapshot.target,
              round.snapshot.effort,
            );
            const record: Execution = {
              id: randomUUID(),
              objectId: round.snapshot.id,
              testId: test.id,
              at: this.now(),
              finishedAt: this.now(),
              snapshot: round.snapshot,
              test,
              request: { args, stdin: prompt },
              call: "error",
              verdict: null,
              answer: null,
              raw: "",
              error: null,
              usage: null,
              artifact: null,
              extraction: null,
              actualModel: null,
              backend: "codex-cli",
              transport: "codex-exec",
              toolPolicy: "cli-read-only",
              maxTokensEnforced: false,
              cli: {
                version: null,
                threadId: null,
                exitCode: null,
                toolEvents: 0,
                errorKind: null,
              },
            };
            this.controller = new AbortController();
            this.current = round.snapshot.id;
            let timedOut = false;
            const timeout = setTimeout(() => {
              timedOut = true;
              this.controller?.abort();
            }, round.snapshot.timeoutSeconds * 1000);
            try {
              const result = await runCodex({
                executable: this.store.settings().codexPath ?? "",
                args,
                prompt,
                signal: this.controller.signal,
                cli: record.cli!,
              });
              record.call = "success";
              record.raw = redact(result.raw, "");
              record.usage = result.usage;
              if (test.kind === "logic")
                Object.assign(record, grade(record.raw, test));
              else Object.assign(record, extract(record.raw));
            } catch (e) {
              record.call = timedOut
                ? "timeout"
                : this.stopped || this.controller.signal.aborted
                  ? "interrupted"
                  : "error";
              record.error = redact(
                e instanceof Error ? e.message : "请求失败",
                "",
              );
            } finally {
              clearTimeout(timeout);
              this.controller = null;
              this.current = null;
              record.finishedAt = this.now();
            }
            this.store.add(record);
            if (record.artifact) this.artworkReady(record.id);
          }
        } finally {
          this.pending.delete(round.snapshot.id);
        }
      }
    } catch {
      this.error = "历史保存失败，调度已停止。请检查本地存储后重启插件。";
      this.stopped = true;
    } finally {
      this.task = null;
    }
  }
  async idle() {
    await this.task;
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.idle();
    this.queue = [];
    this.pending.clear();
  }
}
