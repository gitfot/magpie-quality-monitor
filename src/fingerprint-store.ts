import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { HTTPError } from "./types.ts";
import {
  finishBatch,
  parseBaseline,
  type Baseline,
  type FingerprintObject,
  type FingerprintBatch,
  type FingerprintSample,
} from "./fingerprint.ts";

export class FingerprintStore {
  constructor(
    private db: Database,
    recoveredAt: number,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS fingerprints (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS baselines (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fingerprint_batches (id TEXT PRIMARY KEY, object_id TEXT NOT NULL, at REAL NOT NULL, finished REAL, value TEXT NOT NULL, summary TEXT);
      CREATE INDEX IF NOT EXISTS fingerprint_time ON fingerprint_batches(at);
      CREATE TABLE IF NOT EXISTS fingerprint_samples (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, at REAL NOT NULL, call TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS fingerprint_sample_batch ON fingerprint_samples(batch_id);
      CREATE INDEX IF NOT EXISTS fingerprint_sample_time ON fingerprint_samples(at);`);
    if (
      !(
        db.query("PRAGMA table_info(fingerprint_batches)").all() as {
          name: string;
        }[]
      ).some((c) => c.name === "summary")
    )
      db.exec("ALTER TABLE fingerprint_batches ADD COLUMN summary TEXT");
    const preset = JSON.parse(
      readFileSync(
        new URL("./fingerprint-baselines.json", import.meta.url),
        "utf8",
      ),
    );
    for (const entry of preset.entries)
      this.import(entry, preset.source, preset.license);
    // A process restart cannot resume an independent CLI execution or a round.
    for (const b of this.batches())
      if (b.finishedAt === null) {
        finishBatch(b, recoveredAt, true);
        this.saveBatch(b);
      }
    for (const row of db
      .query("SELECT value FROM fingerprint_batches WHERE summary IS NULL")
      .all() as { value: string }[])
      this.saveBatch(JSON.parse(row.value));
    // A crashed scheduled round may have cleared nextAt before its first sample.
    // Do not invent a batch or catch up; start the next interval after recovery.
    for (const object of this.objects())
      if (object.enabled && object.nextAt === null) {
        object.lastFinishedAt = recoveredAt;
        object.nextAt = recoveredAt + object.intervalMinutes * 60000;
        this.save(object);
      }
  }
  private list<T>(table: string): T[] {
    return (
      this.db.query(`SELECT value FROM ${table} ORDER BY rowid`).all() as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value));
  }
  objects() {
    return this.list<FingerprintObject>("fingerprints");
  }
  object(id: string) {
    const row = this.db
      .query("SELECT value FROM fingerprints WHERE id=?")
      .get(id) as { value: string } | null;
    return row ? (JSON.parse(row.value) as FingerprintObject) : undefined;
  }
  save(o: FingerprintObject) {
    this.db
      .query(
        "INSERT INTO fingerprints VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(o.id, JSON.stringify(o));
  }
  baselines() {
    return this.list<Baseline>("baselines");
  }
  baseline(id: string) {
    const row = this.db
      .query("SELECT value FROM baselines WHERE id=?")
      .get(id) as { value: string } | null;
    return row ? (JSON.parse(row.value) as Baseline) : undefined;
  }
  import(input: unknown, source?: string, license?: string) {
    const b = parseBaseline(input, source, license),
      existing = this.baseline(b.id);
    if (existing) return existing;
    this.db
      .query("INSERT INTO baselines VALUES (?,?)")
      .run(b.id, JSON.stringify(b));
    return b;
  }
  archive(id: string, archived: boolean) {
    const b = this.baseline(id);
    if (!b) throw new HTTPError(404, "Baseline not found");
    b.archived = archived;
    this.db
      .query("UPDATE baselines SET value=? WHERE id=?")
      .run(JSON.stringify(b), id);
    return b;
  }
  batches() {
    return this.list<FingerprintBatch>("fingerprint_batches");
  }
  batch(id: string): FingerprintBatch | undefined {
    const row = this.db
      .query("SELECT value FROM fingerprint_batches WHERE id=?")
      .get(id) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  }
  summaries() {
    return (
      this.db
        .query("SELECT summary FROM fingerprint_batches ORDER BY rowid")
        .all() as { summary: string }[]
    ).map((r) => JSON.parse(r.summary));
  }
  saveBatch(b: FingerprintBatch) {
    if (!this.object(b.objectId)) return;
    const { snapshot, row, baseline, counts, ...summary } = b;
    const compact = {
      ...summary,
      target: row.target,
      name: row.name,
      effort: row.effort,
      baselineName: baseline.name,
      version: snapshot.version,
      budget: snapshot.samples,
    };
    this.db
      .query(
        "INSERT INTO fingerprint_batches (id,object_id,at,finished,value,summary) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET finished=excluded.finished,value=excluded.value,summary=excluded.summary",
      )
      .run(
        b.id,
        b.objectId,
        b.at,
        b.finishedAt,
        JSON.stringify(b),
        JSON.stringify(compact),
      );
  }
  addSample(b: FingerprintBatch, s: FingerprintSample) {
    if (!this.object(b.objectId)) return;
    this.db.transaction(() => {
      this.saveBatch(b);
      this.db
        .query("INSERT INTO fingerprint_samples VALUES (?,?,?,?,?)")
        .run(s.id, b.id, s.at, s.call, JSON.stringify(s));
    })();
  }
  samples(id: string) {
    return (
      this.db
        .query(
          "SELECT value FROM fingerprint_samples WHERE batch_id=? ORDER BY rowid",
        )
        .all(id) as { value: string }[]
    ).map((x) => JSON.parse(x.value) as FingerprintSample);
  }
  samplePage(id: string, page: number) {
    const total = (
      this.db
        .query(
          "SELECT COUNT(*) AS total FROM fingerprint_samples WHERE batch_id=?",
        )
        .get(id) as { total: number }
    ).total;
    const items = (
      this.db
        .query(
          "SELECT value FROM fingerprint_samples WHERE batch_id=? ORDER BY rowid LIMIT 50 OFFSET ?",
        )
        .all(id, (page - 1) * 50) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as FingerprintSample);
    return { total, page, items };
  }
  callsSince(at: number) {
    return this.db
      .query(
        "SELECT COUNT(*) AS attempted, COALESCE(SUM(call='success'),0) AS success FROM fingerprint_samples WHERE at>=?",
      )
      .get(at) as { attempted: number; success: number };
  }
  remove(id: string) {
    this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM fingerprint_samples WHERE batch_id IN (SELECT id FROM fingerprint_batches WHERE object_id=?)",
        )
        .run(id);
      this.db
        .query("DELETE FROM fingerprint_batches WHERE object_id=?")
        .run(id);
      this.db.query("DELETE FROM fingerprints WHERE id=?").run(id);
    })();
  }
  clean(cutoff: number) {
    this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM fingerprint_samples WHERE batch_id IN (SELECT id FROM fingerprint_batches WHERE finished IS NOT NULL AND at<?)",
        )
        .run(cutoff);
      this.db
        .query(
          "DELETE FROM fingerprint_batches WHERE finished IS NOT NULL AND at<?",
        )
        .run(cutoff);
    })();
  }
}
