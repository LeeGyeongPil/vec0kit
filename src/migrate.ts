// migrate: 백업 → 임시 vec0 생성 → 복사(또는 재임베딩, 배치마다 커밋) → 검증 → 같은 이름으로 재생성 교체.
//
// 왜 RENAME 을 쓰지 않나: sqlite-vec 0.1.9 에서 ALTER TABLE ... RENAME 은 섀도 테이블(<t>_chunks 등)의
// 이름을 바꾸지 않아 테이블이 깨진다(조사 프로브에서 재현). 그래서 교체는 한 트랜잭션 안에서
// "원본 DROP → 같은 이름·새 선언으로 CREATE → 임시에서 INSERT … SELECT → 임시 DROP" 으로 한다.
// vec0 DDL 도 트랜잭션 안에서 롤백되므로(프로브 확인) 중간에 실패하면 원본이 그대로 남는다.
import { type Database, isLockError, lockedError, quoteIdent, tableExists } from "./db.js";
import { effectiveMetric, formatVec0Declaration, vectorColumns } from "./declaration.js";
import type { Embedder } from "./embedders/types.js";
import { Vec0KitError } from "./errors.js";
import { type InvalidRule, type MigrationPlan, SKIPPED_TABLE, STATE_TABLE, readState } from "./plan.js";
import { type VerifyReport, verifyMigration } from "./verify.js";
import { invalidReason, toBlob } from "./vectors.js";

export interface MigrateProgress {
  phase: "backup" | "copy" | "embed" | "verify" | "swap";
  done: number;
  total: number;
  /** 이번 실행에서 처리한 배치 번호(1부터) */
  batch: number;
}

export interface MigrateOptions {
  embedder?: Embedder;
  /** 백업 파일 경로. 없으면 백업하지 않는다(CLI 는 기본으로 경로를 만들어 넘긴다) */
  backupPath?: string | null;
  /** 계획의 배치 크기를 덮어쓴다(이어서 하기에 영향 없음) */
  batchSize?: number;
  /** 배치가 커밋될 때마다 불린다. 여기서 예외를 던지면 그 배치까지 저장된 채로 멈춘다(이어서 하기 테스트에 쓴다) */
  onProgress?: (p: MigrateProgress) => void;
}

export interface SkippedRows {
  rule: InvalidRule | "missing-vector";
  count: number;
  sample: (bigint | string)[];
}

export interface MigrationResult {
  table: string;
  mode: MigrationPlan["mode"];
  resumed: boolean;
  /** 이어서 할 때 이미 끝나 있던 행 수 */
  resumedFrom: number;
  rowsBefore: number;
  rowsAfter: number;
  /** 이번 실행에서 임베더에 보낸 텍스트 수 */
  embedded: number;
  skipped: SkippedRows[];
  orphansDropped: number;
  verify: VerifyReport;
  backupPath: string | null;
  afterSql: string;
}

/** 쓰기 트랜잭션(BEGIN IMMEDIATE): 다른 연결이 잠금을 쥐고 있으면 E_LOCKED */
function writeTx<T>(db: Database, fn: () => T): T {
  try {
    return db.transaction(fn).immediate();
  } catch (err) {
    if (isLockError(err)) throw lockedError(db.name);
    throw err;
  }
}

function sqlString(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function ensureStateTables(db: Database): void {
  db.exec(`create table if not exists ${STATE_TABLE}(
    tbl text primary key, plan_hash text not null, plan_json text not null, phase text not null,
    cursor any, done integer not null default 0, backup_path text, started_at text not null)`);
  db.exec(`create table if not exists ${SKIPPED_TABLE}(tbl text not null, rule text not null, k any not null, primary key (tbl, k))`);
}

/** 상태 테이블에 남은 이행이 없으면 상태 테이블 자체를 지운다(교체·abort 뒤 잔여 0) */
function dropStateTablesIfEmpty(db: Database): void {
  if (!tableExists(db, STATE_TABLE)) return;
  const left = Number((db.prepare(`select count(*) as c from ${STATE_TABLE}`).get() as { c: bigint }).c);
  if (left === 0) {
    db.exec(`drop table ${STATE_TABLE}`);
    db.exec(`drop table if exists ${SKIPPED_TABLE}`);
  }
}

function skippedSummary(db: Database, table: string): SkippedRows[] {
  if (!tableExists(db, SKIPPED_TABLE)) return [];
  const rows = db.prepare(`select rule, k from ${SKIPPED_TABLE} where tbl = ? order by rule, k`).all(table) as { rule: SkippedRows["rule"]; k: bigint | string }[];
  const byRule = new Map<SkippedRows["rule"], SkippedRows>();
  for (const r of rows) {
    const s = byRule.get(r.rule) ?? { rule: r.rule, count: 0, sample: [] };
    s.count++;
    if (s.sample.length < 10) s.sample.push(r.k);
    byRule.set(r.rule, s);
  }
  return [...byRule.values()];
}

export async function migrate(db: Database, plan: MigrationPlan, opts: MigrateOptions = {}): Promise<MigrationResult> {
  // ---- 0) 시작 전 확인: 잘못된 벡터·임베더 ----
  if (plan.mode !== "reembed" && plan.invalid.length > 0 && plan.onInvalid === "fail") {
    const total = plan.invalid.reduce((n, f) => n + f.count, 0);
    throw new Vec0KitError(
      "E_INVALID_VECTORS",
      `${total} invalid vectors in ${plan.table} (${plan.invalid.map((f) => `${f.rule} ${f.count}`).join(", ")}); fix them or use --on-invalid skip`,
      { table: plan.table, count: total, rules: plan.invalid.map((f) => f.rule).join(", ") },
      plan.invalid.map((f) => ({ rule: f.rule, count: f.count, sample: f.keys.slice(0, 10) })),
    );
  }
  const embedder = opts.embedder;
  if (plan.mode === "reembed") {
    if (!embedder) throw new Vec0KitError("E_PLAN", "reembed plan needs an embedder", { reason: "embedder-missing" });
    if (embedder.id && plan.embedderId && embedder.id !== plan.embedderId) {
      throw new Vec0KitError("E_PLAN", `embedder ${embedder.id} does not match the plan (${plan.embedderId})`, { reason: "embedder-mismatch", detail: embedder.id });
    }
  }
  // 상태를 다시 읽는다(계획 이후 다른 실행이 끝냈을 수도 있다)
  const state = readState(db, plan.table);
  if (state && state.hash !== plan.hash) {
    throw new Vec0KitError("E_RESUME_MISMATCH", `a different migration of ${plan.table} is in progress`, { table: plan.table });
  }
  // 앱이 DB 를 쓰는 중이면 여기서 멈춘다(아무것도 바꾸기 전)
  writeTx(db, () => undefined);

  const resumed = state !== null;
  const resumedFrom = state?.done ?? 0;
  let backupPath = state?.backupPath ?? null;

  // ---- 1) 백업 + 임시 테이블 + 상태 기록 (처음 실행일 때만) ----
  if (!resumed) {
    if (opts.backupPath) {
      opts.onProgress?.({ phase: "backup", done: 0, total: plan.rowsToProcess, batch: 0 });
      await db.backup(opts.backupPath); // 일관된 스냅숏(WAL 포함)
      backupPath = opts.backupPath;
    }
    writeTx(db, () => {
      ensureStateTables(db);
      db.prepare(`insert into ${STATE_TABLE}(tbl, plan_hash, plan_json, phase, cursor, done, backup_path, started_at) values (?, ?, ?, 'filling', null, 0, ?, ?)`).run(
        plan.table,
        plan.hash,
        JSON.stringify({ beforeSql: plan.beforeSql, afterSql: plan.afterSql, mode: plan.mode, source: plan.source, embedderId: plan.embedderId }),
        backupPath,
        new Date().toISOString(),
      );
      db.exec(formatVec0Declaration(plan.after, plan.tempTable));
    });
  }

  // ---- 2) 채우기 ----
  let embedded = 0;
  const phase = readState(db, plan.table)!.phase;
  if (phase === "filling") {
    if (plan.mode === "reembed") embedded = await fillByReembedding(db, plan, embedder!, opts);
    else fillByCopy(db, plan, opts);
  }

  // ---- 3) 검증 (실패하면 원본·임시 테이블을 그대로 두고 멈춘다 → 다시 실행하거나 --abort) ----
  opts.onProgress?.({ phase: "verify", done: plan.rowsToProcess, total: plan.rowsToProcess, batch: 0 });
  const verify = verifyMigration(db, plan);
  const skipped = skippedSummary(db, plan.table);
  if (!verify.passed) {
    throw new Vec0KitError("E_VERIFY", `verification failed (${verify.failures.join(", ")}); ${plan.table} was not changed`, { table: plan.table, failures: verify.failures.join(", ") }, verify);
  }

  // ---- 4) 교체: 한 트랜잭션 — DROP → 같은 이름 CREATE → 복사 → 임시·상태 DROP ----
  opts.onProgress?.({ phase: "swap", done: verify.rowCount.actual, total: verify.rowCount.actual, batch: 0 });
  const rowsAfter = writeTx(db, () => {
    const t = quoteIdent(plan.table);
    const tmp = quoteIdent(plan.tempTable);
    const cols = insertColumns(plan).map(quoteIdent).join(", ");
    db.exec(`DROP TABLE ${t}`);
    db.exec(formatVec0Declaration(plan.after, plan.table));
    db.exec(`INSERT INTO ${t}(${cols}) SELECT ${cols} FROM ${tmp}`);
    const n = Number((db.prepare(`select count(*) as c from ${t}`).get() as { c: bigint }).c);
    if (n !== verify.rowCount.actual) throw new Vec0KitError("E_VERIFY", `swap copied ${n} rows, expected ${verify.rowCount.actual}`, { table: plan.table, failures: "swap" });
    db.exec(`DROP TABLE ${tmp}`);
    db.prepare(`delete from ${STATE_TABLE} where tbl = ?`).run(plan.table);
    db.prepare(`delete from ${SKIPPED_TABLE} where tbl = ?`).run(plan.table);
    dropStateTablesIfEmpty(db);
    return n;
  });

  return {
    table: plan.table,
    mode: plan.mode,
    resumed,
    resumedFrom,
    rowsBefore: plan.rowCount,
    rowsAfter,
    embedded,
    skipped,
    orphansDropped: plan.mode === "reembed" ? plan.orphansDropped : 0,
    verify,
    backupPath,
    afterSql: formatVec0Declaration(plan.after, plan.table),
  };
}

/** 임시 테이블에 실제로 값을 넣는 열(채우지 않는 새 파티션·보조 열은 NULL 로 두려고 뺀다) */
function insertColumns(plan: MigrationPlan): string[] {
  return plan.columns.map((c) => c.name);
}

/** copy·quantize: SQL 한 문장으로 복사한다 — JS 를 거치지 않아 BigInt·실수 정밀도 문제가 생기지 않는다. */
function fillByCopy(db: Database, plan: MigrationPlan, opts: MigrateOptions): void {
  opts.onProgress?.({ phase: "copy", done: 0, total: plan.rowsToProcess, batch: 1 });
  writeTx(db, () => {
    const insertSkipped = db.prepare(`insert or ignore into ${SKIPPED_TABLE}(tbl, rule, k) values (?, ?, ?)`);
    if (plan.onInvalid === "skip") for (const f of plan.invalid) for (const k of f.keys) insertSkipped.run(plan.table, f.rule, k);
    const cols = plan.columns.map((c) => quoteIdent(c.name)).join(", ");
    const exprs = plan.columns.map((c) => c.expr).join(", ");
    const key = quoteIdent(plan.keyColumn);
    db.exec(`delete from ${quoteIdent(plan.tempTable)}`);
    db.exec(
      `INSERT INTO ${quoteIdent(plan.tempTable)}(${cols}) SELECT ${exprs} FROM ${quoteIdent(plan.table)} v ` +
        `WHERE v.${key} NOT IN (SELECT k FROM ${SKIPPED_TABLE} WHERE tbl = ${sqlString(plan.table)})`,
    );
    const n = Number((db.prepare(`select count(*) as c from ${quoteIdent(plan.tempTable)}`).get() as { c: bigint }).c);
    db.prepare(`update ${STATE_TABLE} set phase = 'filled', done = ? where tbl = ?`).run(BigInt(n), plan.table);
  });
  opts.onProgress?.({ phase: "copy", done: plan.rowsToProcess, total: plan.rowsToProcess, batch: 1 });
}

/**
 * reembed: 본문 테이블을 키 순서로 배치씩 읽어 임베딩하고, 배치마다 [행 삽입 + 커서 갱신] 을 한 트랜잭션으로 커밋한다.
 * 중간에 멈춰도 커밋된 배치는 남고, 같은 명령을 다시 실행하면 커서 다음 행부터 이어서 한다.
 */
async function fillByReembedding(db: Database, plan: MigrationPlan, embedder: Embedder, opts: MigrateOptions): Promise<number> {
  const src = plan.source!;
  const text = src.text!;
  const sk = quoteIdent(src.key);
  const batchSize = opts.batchSize ?? plan.batchSize;
  const newVec = vectorColumns(plan.after).find((v) => v.name === plan.vectorColumn)!;
  const cosine = effectiveMetric(newVec) === "cosine";
  const sourceCols = plan.columns.filter((c) => c.from === "source");
  const oldCols = plan.columns.filter((c) => c.from === "old");
  // 본문 쪽 선택 열: 키, 본문, 채울 열
  const selectList = [`d.${sk} as __k`, `d.${quoteIdent(text)} as __text`, ...sourceCols.map((c, i) => `d.${quoteIdent(c.sourceColumn!)} as __f${i}`)].join(", ");
  const firstBatch = db.prepare(`select ${selectList} from ${quoteIdent(src.table)} d where d.${sk} is not null order by d.${sk} limit ?`);
  const nextBatch = db.prepare(`select ${selectList} from ${quoteIdent(src.table)} d where d.${sk} > ? order by d.${sk} limit ?`);
  const readOld = oldCols.length > 0 ? db.prepare(`select ${oldCols.map((c) => quoteIdent(c.name)).join(", ")} from ${quoteIdent(plan.table)} where ${quoteIdent(plan.keyColumn)} = ?`) : null;
  const insertCols = [plan.keyColumn, plan.vectorColumn, ...oldCols.map((c) => c.name), ...sourceCols.map((c) => c.name)];
  const insert = db.prepare(`insert into ${quoteIdent(plan.tempTable)}(${insertCols.map(quoteIdent).join(", ")}) values (${insertCols.map(() => "?").join(", ")})`);
  const insertSkipped = db.prepare(`insert or ignore into ${SKIPPED_TABLE}(tbl, rule, k) values (?, ?, ?)`);
  const saveCursor = db.prepare(`update ${STATE_TABLE} set cursor = ?, done = done + ? where tbl = ?`);
  const readCursor = db.prepare(`select cursor, done from ${STATE_TABLE} where tbl = ?`);

  let embedded = 0;
  let batchNo = 0;
  for (;;) {
    const st = readCursor.get(plan.table) as { cursor: bigint | string | null; done: bigint };
    const rows = (st.cursor === null ? firstBatch.all(batchSize) : nextBatch.all(st.cursor, batchSize)) as Record<string, unknown>[];
    if (rows.length === 0) break;
    batchNo++;

    // 옛 행에서 가져올 값(메타·보조). 옛 행이 없고 메타가 필요하면 그 행은 건너뛴다(메타데이터는 NULL 불가).
    const prepared: { key: bigint | string; text: string; old: Record<string, unknown> | null; fills: unknown[] }[] = [];
    const skippedNow: { key: bigint | string; rule: SkippedRows["rule"] }[] = [];
    for (const r of rows) {
      const k = r.__k as bigint | string;
      const old = readOld ? ((readOld.get(k) as Record<string, unknown> | undefined) ?? null) : null;
      if (readOld && !old && plan.metadataFromOldRow) {
        skippedNow.push({ key: k, rule: "missing-vector" });
        continue;
      }
      prepared.push({ key: k, text: r.__text == null ? "" : String(r.__text), old, fills: sourceCols.map((_, i) => r[`__f${i}`]) });
    }

    // 임베딩(트랜잭션 밖에서 기다린다 — 느린 모델이 DB 잠금을 쥐지 않게)
    const vectors = prepared.length > 0 ? await embedder.embed(prepared.map((p) => p.text)) : [];
    embedded += prepared.length;
    if (vectors.length !== prepared.length) throw new Vec0KitError("E_EMBED", `embedder returned ${vectors.length} vectors for ${prepared.length} texts`, { detail: `count ${vectors.length} != ${prepared.length}` });

    const toInsert: { p: (typeof prepared)[number]; v: Float32Array }[] = [];
    prepared.forEach((p, i) => {
      const v = vectors[i]!;
      if (v.length !== newVec.dims) throw new Vec0KitError("E_EMBED", `embedding has ${v.length} dimensions, the new column needs ${newVec.dims}`, { reason: "embed-dims", got: v.length, expected: newVec.dims });
      const bad = invalidReason(v, cosine);
      if (bad) {
        if (plan.onInvalid === "fail") {
          throw new Vec0KitError("E_INVALID_VECTORS", `embedder returned a ${bad} for key ${String(p.key)}; use --on-invalid skip`, { reason: "embed-invalid", table: plan.table, count: 1, rules: bad, key: String(p.key) }, [{ rule: bad, count: 1, sample: [p.key] }]);
        }
        skippedNow.push({ key: p.key, rule: bad });
      } else {
        toInsert.push({ p, v });
      }
    });

    const lastKey = rows[rows.length - 1]!.__k as bigint | string;
    writeTx(db, () => {
      for (const { p, v } of toInsert) {
        insert.run(p.key, toBlob(v), ...oldCols.map((c) => p.old?.[c.name] ?? null), ...p.fills);
      }
      for (const s of skippedNow) insertSkipped.run(plan.table, s.rule, s.key);
      saveCursor.run(lastKey, BigInt(rows.length), plan.table);
    });
    const done = Number((readCursor.get(plan.table) as { done: bigint }).done);
    opts.onProgress?.({ phase: "embed", done, total: plan.rowsToProcess, batch: batchNo });
  }
  db.prepare(`update ${STATE_TABLE} set phase = 'filled' where tbl = ?`).run(plan.table);
  return embedded;
}

/** 진행 중인 이행을 취소: 임시 테이블·상태를 지운다. 원본 테이블은 건드리지 않는다. */
export function abortMigration(db: Database, table: string): { removed: boolean } {
  const tmp = `${table}__vec0kit_new`;
  return writeTx(db, () => {
    let removed = false;
    if (tableExists(db, tmp)) {
      db.exec(`DROP TABLE ${quoteIdent(tmp)}`);
      removed = true;
    }
    if (tableExists(db, STATE_TABLE)) {
      removed = db.prepare(`delete from ${STATE_TABLE} where tbl = ?`).run(table).changes > 0 || removed;
      if (tableExists(db, SKIPPED_TABLE)) db.prepare(`delete from ${SKIPPED_TABLE} where tbl = ?`).run(table);
      dropStateTablesIfEmpty(db);
    }
    return { removed };
  });
}
