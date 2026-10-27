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
import {
  fingerprintKey,
  finishBatch,
  samplingPrompt,
  samplingProtocol,
  scoringMethod,
  sampleValue,
  type FingerprintObject,
  type FingerprintRow,
  type FingerprintBatch,
  type FingerprintSample,
} from "./fingerprint.ts";

interface FingerprintRound {
  fingerprint: true;
  snapshot: FingerprintObject;
  rows: FingerprintRow[];
  roundId: string;
  at: number;
  index: number;
  generation: number;
  batch?: FingerprintBatch;
}

export class Engine {
  private queue: (
    | {
        snapshot: MonitorObject;
        testId?: string;
        generation: number;
      }
    | FingerprintRound
  )[] = [];
  private fingerprintRounds = new Map<string, FingerprintRound>();
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
  get fingerprintProgress() {
    return [...this.fingerprintRounds.values()].map((r) => ({
      objectId: r.snapshot.id,
      rowId: r.rows[r.index]?.id,
      waitingRows: r.rows.slice(r.index + 1).map((r) => r.id),
      state: this.current === r.snapshot.id ? "sampling" : "queued",
      attempted: r.batch?.attempted ?? 0,
      valid: r.batch?.valid ?? 0,
      invalid: (r.batch?.attempted ?? 0) - (r.batch?.valid ?? 0),
      budget: r.snapshot.samples,
    }));
  }
  cancel(id: string, abort = false) {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
    if (this.current !== id) {
      this.queue = this.queue.filter((round) => round.snapshot.id !== id);
      this.pending.delete(id);
      const round = this.fingerprintRounds.get(id);
      if (round) this.endFingerprint(round, true);
    }
    if (abort && this.current === id) this.controller?.abort();
  }
  async enqueue(id: string, testId?: string) {
    if (this.stopped || this.error || !this.active())
      throw new HTTPError(503, "调度器不可用");
    const fingerprint = this.store.fingerprint.object(id);
    if (fingerprint) {
      this.access.assertConnected();
      if (this.pending.has(id))
        throw new HTTPError(409, "此对象已有执行中的轮次");
      const rows = fingerprint.rows.filter((r) =>
        testId ? r.id === testId : r.enabled,
      );
      if (!rows.length) throw new HTTPError(400, "No enabled model rows");
      const round: FingerprintRound = {
        fingerprint: true,
        snapshot: fingerprint,
        rows,
        roundId: randomUUID(),
        at: this.now(),
        index: 0,
        generation: this.generations.get(id) ?? 0,
      };
      this.fingerprintRounds.set(id, round);
      this.pending.add(id);
      this.queue.push(round);
      if (!this.task) this.task = Promise.resolve().then(() => this.drain());
      return;
    }
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
      for (const o of this.store.fingerprint.objects()) {
        if (
          !o.enabled ||
          !o.rows.some((r) => r.enabled) ||
          o.nextAt === null ||
          o.nextAt > this.now() ||
          this.pending.has(o.id)
        )
          continue;
        try {
          this.access.assertConnected();
        } catch {
          continue;
        }
        await this.enqueue(o.id);
        o.nextAt = null;
        this.store.fingerprint.save(o);
      }
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
        if ("fingerprint" in round) {
          await this.sampleFingerprint(round);
          continue;
        }
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
    for (const r of this.fingerprintRounds.values())
      this.endFingerprint(r, true);
    this.queue = [];
    this.pending.clear();
  }
  private endFingerprint(round: FingerprintRound, interrupted = false) {
    if (round.batch && round.batch.finishedAt === null) {
      finishBatch(round.batch, this.now(), interrupted);
      this.store.fingerprint.saveBatch(round.batch);
    }
    this.fingerprintRounds.delete(round.snapshot.id);
    this.pending.delete(round.snapshot.id);
    const live = this.store.fingerprint.object(round.snapshot.id);
    if (live) {
      live.lastDurationMs = Math.max(0, this.now() - round.at);
      live.lastFinishedAt = this.now();
      live.nextAt = live.enabled
        ? this.now() + live.intervalMinutes * 60000
        : null;
      this.store.fingerprint.save(live);
    }
  }
  private async sampleFingerprint(round: FingerprintRound) {
    const cancelled = () =>
      this.stopped ||
      !this.active() ||
      !this.store.fingerprint.object(round.snapshot.id) ||
      (this.generations.get(round.snapshot.id) ?? 0) !== round.generation;
    if (cancelled()) {
      this.endFingerprint(round, true);
      return;
    }
    try {
      this.access.assertConnected();
    } catch {
      this.endFingerprint(round, true);
      return;
    }
    const row = round.rows[round.index];
    if (!round.batch) {
      const baseline = this.store.fingerprint.baseline(row.baselineId)!;
      round.batch = {
        id: randomUUID(),
        roundId: round.roundId,
        objectId: round.snapshot.id,
        rowId: row.id,
        at: this.now(),
        finishedAt: null,
        snapshot: round.snapshot,
        row,
        baseline,
        historyKey: fingerprintKey(round.snapshot, row),
        protocol: samplingProtocol,
        method: scoringMethod,
        attempted: 0,
        valid: 0,
        success: 0,
        counts: Array(355).fill(0),
        score: null,
        reason: "running",
      };
      this.store.fingerprint.saveBatch(round.batch);
    }
    const b = round.batch;
    const s: FingerprintSample = {
      id: randomUUID(),
      at: this.now(),
      finishedAt: this.now(),
      call: "error",
      value: null,
      invalid: "call",
      raw: "",
      error: null,
      usage: null,
      cli: {
        version: null,
        threadId: null,
        exitCode: null,
        toolEvents: 0,
        errorKind: null,
      },
    };
    this.current = round.snapshot.id;
    this.controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.controller?.abort();
    }, round.snapshot.timeoutSeconds * 1000);
    try {
      const result = await runCodex({
        executable: this.store.settings().codexPath ?? "",
        args: codexArgs(row.target, row.effort),
        prompt: samplingPrompt,
        signal: this.controller.signal,
        cli: s.cli,
        onText: (text) => {
          s.raw = redact(text, "");
        },
      });
      s.call = "success";
      s.raw = redact(result.raw, "");
      s.usage = result.usage;
      Object.assign(s, sampleValue(result.raw, s.cli.toolEvents));
    } catch (e) {
      s.call = timedOut
        ? "timeout"
        : this.controller.signal.aborted
          ? "interrupted"
          : "error";
      s.error = redact(
        e instanceof Error ? e.message : "CLI execution failed",
        "",
      );
    } finally {
      clearTimeout(timeout);
      this.controller = null;
      this.current = null;
      s.finishedAt = this.now();
    }
    b.attempted++;
    if (s.call === "success") b.success++;
    if (s.value !== null) {
      b.valid++;
      b.counts[s.value - 1]++;
    }
    this.store.fingerprint.addSample(b, s);
    if (cancelled()) {
      this.endFingerprint(round, true);
      return;
    }
    if (b.attempted === round.snapshot.samples) {
      finishBatch(b, this.now());
      this.store.fingerprint.saveBatch(b);
      round.index++;
      round.batch = undefined;
      if (round.index === round.rows.length) {
        this.endFingerprint(round);
        return;
      }
    }
    // A fingerprint owns a round, not the worker: yield after each CLI sample.
    this.queue.push(round);
  }
}
