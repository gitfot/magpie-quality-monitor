import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { historyKey } from "./config.ts";
import { tokenTotal } from "./metrics.ts";
import { FingerprintStore } from "./fingerprint-store.ts";
import type {
  Execution,
  MonitorEvent,
  MonitorObject,
  Settings,
  Thumbnail,
} from "./types.ts";

export class Store {
  private db: Database;
  readonly fingerprint: FingerprintStore;
  constructor(directory: string, recoveredAt = Date.now()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(directory, "monitor.sqlite"), {
      create: true,
      strict: true,
    });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, object_id TEXT, test_id TEXT, at REAL, artifact INTEGER, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_time ON records(at);
      CREATE INDEX IF NOT EXISTS records_test ON records(test_id, at);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, object_id TEXT, at REAL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS thumbnails (record_id TEXT PRIMARY KEY, renderer TEXT NOT NULL, png BLOB, metadata TEXT NOT NULL);`);
    this.fingerprint = new FingerprintStore(this.db, recoveredAt);
    const columns = this.db.query("PRAGMA table_info(records)").all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === "summary"))
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE records ADD COLUMN summary TEXT");
        // One-time, bounded-memory migration for an earlier development database.
        for (const row of this.db
          .query("SELECT id,value FROM records")
          .iterate() as Iterable<{ id: string; value: string }>) {
          this.db
            .query("UPDATE records SET summary=? WHERE id=?")
            .run(JSON.stringify(this.summarize(JSON.parse(row.value))), row.id);
        }
      })();
    this.db.transaction(() => {
      for (const row of this.db
        .query(
          "SELECT id,value FROM records WHERE json_extract(summary,'$.historyKey') IS NULL OR json_type(summary,'$.tokenTotal') IS NULL",
        )
        .iterate() as Iterable<{ id: string; value: string }>)
        this.db
          .query("UPDATE records SET summary=? WHERE id=?")
          .run(JSON.stringify(this.summarize(JSON.parse(row.value))), row.id);
    })();
    this.db.transaction(() => {
      for (const object of this.objects()) {
        let changed = false;
        if (object.backend !== "codex-cli" && !object.needsConversion) {
          object.enabled = false;
          object.nextAt = null;
          object.needsConversion = true;
          this.save(object);
        }
        for (const test of object.tests)
          if (
            test.kind === "logic" &&
            test.gradingMode !== "full-text" &&
            !test.answerRule
          ) {
            test.answerRule = "normalized-v1";
            changed = true;
          }
        if (changed) {
          object.version++;
          this.save(object);
        }
      }
    })();
  }
  objects(): MonitorObject[] {
    return (
      this.db.query("SELECT value FROM objects ORDER BY rowid").all() as {
        value: string;
      }[]
    ).map((x) => JSON.parse(x.value));
  }
  object(id: string): MonitorObject | undefined {
    const row = this.db
      .query("SELECT value FROM objects WHERE id=?")
      .get(id) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  save(object: MonitorObject) {
    this.db
      .query(
        "INSERT INTO objects VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(object.id, JSON.stringify(object));
  }
  remove(id: string) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM records WHERE object_id=?").run(id);
      this.db.query("DELETE FROM events WHERE object_id=?").run(id);
      this.db.query("DELETE FROM objects WHERE id=?").run(id);
      this.cleanThumbnails();
    })();
  }
  settings(): Settings {
    const row = this.db
      .query("SELECT value FROM settings WHERE id=1")
      .get() as { value: string } | null;
    return row ? JSON.parse(row.value) : { retentionDays: 5 };
  }
  setSettings(value: Settings) {
    this.db
      .query("INSERT OR REPLACE INTO settings VALUES(1,?)")
      .run(JSON.stringify(value));
  }
  add(record: Execution) {
    if (!this.object(record.objectId)) return;
    this.db
      .query(
        "INSERT INTO records (id,object_id,test_id,at,artifact,value,summary) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        record.id,
        record.objectId,
        record.testId,
        record.at,
        record.artifact ? 1 : 0,
        JSON.stringify(record),
        JSON.stringify(this.summarize(record)),
      );
  }
  private summarize(r: Execution) {
    return {
      id: r.id,
      objectId: r.objectId,
      testId: r.testId,
      at: r.at,
      finishedAt: r.finishedAt,
      tokenTotal: tokenTotal(r.usage),
      call: r.call,
      verdict: r.verdict,
      hasArtifact: !!r.artifact,
      version: r.snapshot.version,
      testName: r.test.name,
      kind: r.test.kind,
      target: r.snapshot.target,
      backend: r.backend ?? r.snapshot.backend ?? "direct-gateway",
      historyKey: historyKey(
        { ...r.snapshot, backend: r.backend ?? r.snapshot.backend },
        r.test,
      ),
    };
  }
  summaries() {
    return (
      this.db
        .query("SELECT summary FROM records ORDER BY at DESC,rowid DESC")
        .all() as { summary: string }[]
    ).map((r) => JSON.parse(r.summary));
  }
  record(id: string): Execution | undefined {
    const row = this.db
      .query("SELECT value FROM records WHERE id=?")
      .get(id) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  records(): Execution[] {
    return (
      this.db
        .query("SELECT value FROM records ORDER BY at DESC,rowid DESC")
        .all() as { value: string }[]
    ).map((x) => JSON.parse(x.value));
  }
  gallery(testId: string, page: number) {
    const filter = "test_id=? AND artifact=1";
    const total = (
      this.db
        .query("SELECT count(*) AS n FROM records WHERE " + filter)
        .get(testId) as { n: number }
    ).n;
    const items = (
      this.db
        .query(
          "SELECT value FROM records WHERE " +
            filter +
            " ORDER BY at DESC,rowid DESC LIMIT 20 OFFSET ?",
        )
        .all(testId, (page - 1) * 20) as { value: string }[]
    ).map((x) => JSON.parse(x.value) as Execution);
    return { total, page, pageSize: 20, items };
  }
  event(event: MonitorEvent) {
    this.db
      .query("INSERT INTO events VALUES (?,?,?,?)")
      .run(event.id, event.objectId, event.at, JSON.stringify(event));
  }
  events(): MonitorEvent[] {
    return (
      this.db
        .query("SELECT value FROM events ORDER BY at DESC LIMIT 300")
        .all() as { value: string }[]
    ).map((x) => JSON.parse(x.value));
  }
  clean(now: number) {
    this.fingerprint.clean(
      now - (this.settings().fingerprintRetentionDays ?? 30) * 86400000,
    );
    const cutoff = now - this.settings().retentionDays * 86400000;
    this.db.transaction(() => {
      this.db.query("DELETE FROM records WHERE at<?").run(cutoff);
      this.db.query("DELETE FROM events WHERE at<?").run(cutoff);
      this.cleanThumbnails();
    })();
  }
  private cleanThumbnails() {
    this.db.exec(
      "DELETE FROM thumbnails WHERE record_id NOT IN (SELECT id FROM records)",
    );
  }
  thumbnail(id: string, renderer: string): Thumbnail | undefined {
    const row = this.db
      .query(
        "SELECT png, metadata FROM thumbnails WHERE record_id=? AND renderer=?",
      )
      .get(id, renderer) as { png: Uint8Array | null; metadata: string } | null;
    return row
      ? { ...JSON.parse(row.metadata), ...(row.png ? { png: row.png } : {}) }
      : undefined;
  }
  saveThumbnail(id: string, renderer: string, value: Thumbnail) {
    if (!this.record(id)?.artifact) return;
    const { png, ...metadata } = value;
    this.db
      .query("INSERT OR REPLACE INTO thumbnails VALUES (?,?,?,?)")
      .run(id, renderer, png ?? null, JSON.stringify(metadata));
  }
  forgetThumbnail(id: string) {
    this.db.query("DELETE FROM thumbnails WHERE record_id=?").run(id);
  }
  close() {
    this.db.close();
  }
}
