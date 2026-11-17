// DB 열기: better-sqlite3 + sqlite-vec 확장 로드.
// 핵심: safeIntegers(true) — rowid·INTEGER 값을 JS number(2^53 까지만 정확) 가 아니라 BigInt 로 다룬다.
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { Vec0KitError } from "./errors.js";

export type Database = Database.Database;

/** 이 도구가 실제로 검증한 sqlite-vec 버전(다르면 check 가 untested-version 경고) */
export const TESTED_VEC_VERSION = "v0.1.9";

export interface OpenOptions {
  /** 읽기 전용으로 연다(inspect·check 기본값) */
  readonly?: boolean;
  /** 파일이 없으면 새로 만든다(demo 전용). 기본은 없으면 오류. */
  create?: boolean;
  /** 실행되는 모든 SQL 문을 받는 콜백(테스트에서 RENAME 이 없는지 확인할 때 쓴다) */
  trace?: (sql: string) => void;
  /** 다른 프로세스가 잠금을 쥐고 있을 때 기다리는 시간(ms) */
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, opts: OpenOptions = {}): Database {
  if (path !== ":memory:" && !opts.create && !existsSync(path)) {
    throw new Vec0KitError("E_NO_DB", `database file not found: ${path}`, { path });
  }
  const db = new Database(path, {
    readonly: opts.readonly ?? false,
    fileMustExist: !opts.create && path !== ":memory:",
    timeout: opts.busyTimeoutMs ?? 2000,
    ...(opts.trace ? { verbose: (message?: unknown) => opts.trace?.(String(message)) } : {}),
  });
  try {
    sqliteVec.load(db);
    // 첫 질의로 SQLite 파일인지 확인한다(아니면 SQLITE_NOTADB)
    db.prepare("select count(*) from sqlite_master").get();
  } catch (err) {
    db.close();
    if (isNotDatabaseError(err)) throw new Vec0KitError("E_NOT_DB", `not a SQLite database: ${path}`, { path });
    throw new Vec0KitError(
      "E_EXTENSION",
      `could not load the sqlite-vec extension: ${(err as Error).message}`,
      { detail: (err as Error).message },
    );
  }
  // 모든 정수를 BigInt 로 읽는다 — 2^53 을 넘는 rowid 도 정확히 보존된다.
  db.defaultSafeIntegers(true);
  return db;
}

export interface Versions {
  sqliteVecVersion: string;
  sqliteVersion: string;
}

export function getVersions(db: Database): Versions {
  const row = db.prepare("select vec_version() as v, sqlite_version() as s").get() as { v: string; s: string };
  return { sqliteVecVersion: row.v, sqliteVersion: row.s };
}

/** SQL 식별자 따옴표 처리: 안전한 이름은 그대로, 아니면 "..." 로 감싼다. */
export function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** 일반 테이블·열 이름이 실제로 있는지 */
export function tableExists(db: Database, name: string): boolean {
  return db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== undefined;
}

export function columnNames(db: Database, table: string): string[] {
  const rows = db.prepare("select name from pragma_table_xinfo(?)").all(table) as { name: string }[];
  return rows.map((r) => r.name);
}

/** SQLITE_BUSY·SQLITE_LOCKED 를 E_LOCKED 로 바꾼다(앱이 DB 를 쓰는 중). */
export function isLockError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

/** SQLITE_NOTADB·SQLITE_CORRUPT: the file is not a SQLite database. */
export function isNotDatabaseError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "SQLITE_NOTADB" || code === "SQLITE_CORRUPT";
}

export function lockedError(path: string): Vec0KitError {
  return new Vec0KitError("E_LOCKED", `database is locked by another connection: ${path}`, { path });
}

/** BigInt·number 를 출력용 값으로: 안전한 범위면 number, 넘으면 문자열(정밀도 손실 방지). */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  return value;
}
