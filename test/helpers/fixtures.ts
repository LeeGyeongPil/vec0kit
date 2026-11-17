// 테스트 픽스처: 문제를 심은 DB, BigInt rowid, 텍스트 PK, 200행 말뭉치 DB 를 코드로 만든다.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { type CliIO, run } from "../../src/cli.js";
import { type Database, openDatabase } from "../../src/db.js";
import { demoDocuments } from "../../src/demo-corpus.js";
import { mockEmbed } from "../../src/embedders/mock.js";
import { toBlob } from "../../src/vectors.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** 테스트마다 새 임시 폴더(끝나면 지운다) */
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "vec0kit-test-"));
  dirs.push(d);
  return d;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function withDb<T>(path: string, fn: (db: Database) => T): T {
  const db = openDatabase(path, { create: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export const f32 = (xs: number[]) => toBlob(new Float32Array(xs));

/** 결정적 의사 난수 벡터(정규화하지 않음) */
export function wave(i: number, dims: number): number[] {
  return Array.from({ length: dims }, (_, j) => Math.sin(i * 1.7 + j * 0.9) + 0.3 * Math.cos(i * j + 1));
}

/**
 * AC-2 픽스처: docs 1..20, vec_docs float[8] (metric 선택), 심은 문제
 *   zero-vector: rowid 1 (맨 먼저 넣는다), non-finite: 5(NaN)·6(Inf), orphan: 101·102, missing: 20
 */
export function makeProblemDb(path: string, metric: "cosine" | "l2" = "cosine"): void {
  withDb(path, (db) => {
    db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[8] distance_metric=${metric}, cat text, +note text);`);
    const insDoc = db.prepare("INSERT INTO docs(id, body) VALUES (?, ?)");
    const insVec = db.prepare("INSERT INTO vec_docs(rowid, embedding, cat, note) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 1; i <= 20; i++) insDoc.run(BigInt(i), `document ${i}`);
      for (let i = 1; i <= 19; i++) {
        let v = wave(i, 8);
        if (i === 1) v = new Array(8).fill(0);
        if (i === 5) v[2] = Number.NaN;
        if (i === 6) v[0] = Number.POSITIVE_INFINITY;
        insVec.run(BigInt(i), f32(v), i % 2 ? "odd" : "even", `note ${i}`);
      }
      for (const id of [101, 102]) insVec.run(BigInt(id), f32(wave(id, 8)), "odd", "orphan");
    })();
  });
}

/** 문제 없는 DB: docs 1..20 과 같은 키의 벡터 20개 */
export function makeCleanDb(path: string, metric: "cosine" | "l2" = "l2"): void {
  withDb(path, (db) => {
    db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT NOT NULL, category TEXT NOT NULL);
      CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[8] distance_metric=${metric}, cat text, +note text);`);
    const insDoc = db.prepare("INSERT INTO docs(id, body, category) VALUES (?, ?, ?)");
    const insVec = db.prepare("INSERT INTO vec_docs(rowid, embedding, cat, note) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (let i = 1; i <= 20; i++) {
        insDoc.run(BigInt(i), `document ${i}`, i % 3 ? "news" : "blog");
        insVec.run(BigInt(i), f32(wave(i, 8)), i % 2 ? "odd" : "even", `note ${i}`);
      }
    })();
  });
}

/** 200행 말뭉치: docs(id, topic, body) + vec_docs float[dims] (목 임베더로 계산한 단위 벡터) */
export function makeCorpusDb(path: string, opts: { dims?: number; metric?: "cosine" | "l2"; rows?: number } = {}): void {
  const dims = opts.dims ?? 64;
  const rows = opts.rows ?? 200;
  withDb(path, (db) => {
    db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, topic TEXT NOT NULL, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[${dims}] distance_metric=${opts.metric ?? "l2"}, topic text, +title text);`);
    const insDoc = db.prepare("INSERT INTO docs(id, topic, body) VALUES (?, ?, ?)");
    const insVec = db.prepare("INSERT INTO vec_docs(rowid, embedding, topic, title) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      for (const d of demoDocuments(rows)) {
        insDoc.run(BigInt(d.id), d.topic, d.body);
        insVec.run(BigInt(d.id), toBlob(mockEmbed(d.body, dims)), d.topic, d.body.slice(0, 20));
      }
    })();
  });
}

export function declarationOf(path: string, table: string): string {
  return withDb(path, (db) => (db.prepare("select sql from sqlite_master where name = ?").get(table) as { sql: string }).sql);
}

export function countRows(path: string, table: string): number {
  return withDb(path, (db) => Number((db.prepare(`select count(*) as c from ${table}`).get() as { c: bigint }).c));
}

export function masterNames(path: string): string[] {
  return withDb(path, (db) => (db.prepare("select name from sqlite_master order by name").all() as { name: string }[]).map((r) => r.name));
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** CLI 를 같은 프로세스에서 실행하고 출력을 모은다. 언어는 기본 영어로 고정(환경 LANG 영향 제거). */
export async function cli(args: string[], env: Record<string, string> = {}, cwd = process.cwd()): Promise<CliRun> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env: { LANG: "C", ...env },
    cwd,
  };
  const code = await run(args, io);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

export const HANGUL = /[가-힣]/;
