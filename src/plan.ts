// plan: 현재 선언 + 변경 옵션 → 새 선언·작업 종류(copy·quantize·reembed)·복사 식·한도 검증.
// 계획 단계는 DB 를 바꾸지 않는다(--dry-run 은 여기까지만 실행한다).
import { createHash } from "node:crypto";
import { type Database, columnNames, quoteIdent, tableExists } from "./db.js";
import {
  LIMITS,
  type Vec0Column,
  type Vec0Declaration,
  type VectorColumn,
  countByKind,
  effectiveMetric,
  formatVec0Declaration,
  isTableOption,
  keyColumn,
  parseUserColumn,
  primaryKey,
  vectorBytes,
  vectorColumns,
} from "./declaration.js";
import { type MessageParams, Vec0KitError } from "./errors.js";
import { requireDeclaration } from "./inspect.js";
import { vectorStats } from "./vectors.js";

export type MigrationMode = "copy" | "quantize" | "reembed";
export type InvalidRule = "zero-vector" | "non-finite";

export interface SourceSpec {
  table: string;
  key: string;
  /** 재임베딩할 본문 열 */
  text?: string;
}

export interface MigrationOptions {
  table: string;
  /** 새 벡터 열 선언 — 예: "embedding float[768] distance_metric=cosine" */
  to?: string;
  /** 벡터 열이 여러 개일 때 바꿀 열 */
  column?: string;
  quantize?: "int8" | "bit";
  addColumns?: string[];
  dropColumns?: string[];
  /** 새 열 → 본문 테이블 열(값을 채울 곳) */
  fill?: Record<string, string>;
  /** 재임베딩에 쓸 임베더 식별자(Embedder.id). 있으면 reembed 모드 */
  reembed?: string;
  source?: SourceSpec;
  batchSize?: number;
  minRecall?: number;
  sample?: number;
  k?: number;
  onInvalid?: "fail" | "skip";
}

/** 임시 테이블에 넣을 열 하나: 어디서 값을 가져오는지 */
export interface CopyColumn {
  name: string;
  from: "key" | "old" | "transform" | "source" | "embed";
  /** copy·quantize 모드에서 쓰는 SQL 식(옛 테이블 별칭 v, 본문 테이블 별칭 d) */
  expr: string;
  /** from = "source" 일 때 본문 테이블의 열 이름 */
  sourceColumn?: string;
}

export interface InvalidVectors {
  rule: InvalidRule;
  count: number;
  /** 모든 키(건너뛰기에 쓴다) */
  keys: (bigint | string)[];
}

export interface PlanNote {
  key: string;
  params: MessageParams;
}

export interface MigrationPlan {
  table: string;
  tempTable: string;
  mode: MigrationMode;
  vectorColumn: string;
  keyColumn: string;
  keyType: "integer" | "text";
  before: Vec0Declaration;
  after: Vec0Declaration;
  beforeSql: string;
  afterSql: string;
  columns: CopyColumn[];
  source: SourceSpec | null;
  embedderId: string | null;
  /** 옛 테이블 행 수 */
  rowCount: number;
  /** 처리할 행 수(copy: 옛 테이블, reembed: 본문 테이블) */
  rowsToProcess: number;
  batchSize: number;
  batches: number;
  minRecall: number | null;
  sample: number;
  k: number;
  onInvalid: "fail" | "skip";
  /** copy·quantize 에서 시작 전에 찾은 잘못된 벡터 */
  invalid: InvalidVectors[];
  /** reembed: 본문에 없는 벡터 행(고아)은 새 테이블로 가지 않는다 */
  orphansDropped: number;
  /** reembed: 벡터가 아직 없는 본문 행 수(메타 값을 옛 행에서 가져와야 하면 건너뛴다) */
  sourceRowsWithoutVector: number;
  metadataFromOldRow: boolean;
  estimatedExtraBytes: number;
  notes: PlanNote[];
  /** 이어서 하기 판단에 쓰는 계획 지문(배치 크기·recall 기준 등 결과에 영향 없는 값은 빼고 계산) */
  hash: string;
  /** 이미 진행 중인 같은 계획이 있으면 진행 상황 */
  resume: { done: number; phase: string; backupPath: string | null } | null;
}

export const STATE_TABLE = "_vec0kit_migration";
export const SKIPPED_TABLE = "_vec0kit_migration_skipped";
export const DEFAULT_BATCH_SIZE = 1000;

export function tempTableName(table: string): string {
  return `${table}__vec0kit_new`;
}

/** 계획 거부(E_PLAN). reason 은 번역 메시지 키(reason.<reason>)이다. */
const FILL_SAMPLE_LIMIT = 10;

function planError(reason: string, message: string, params: MessageParams = {}): Vec0KitError {
  return new Vec0KitError("E_PLAN", message, { reason, detail: message, ...params });
}

function usageError(reason: string, message: string, params: MessageParams = {}): Vec0KitError {
  return new Vec0KitError("E_USAGE", message, { reason, detail: message, ...params });
}

/** "docs:id:body" → {table, key, text} */
export function parseSourceSpec(spec: string): SourceSpec {
  const parts = spec.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.trim() === "")) {
    throw usageError("source-format", `--source must look like table:key or table:key:text, got ${spec}`, { spec });
  }
  const [table, key, text] = parts.map((p) => p.trim());
  return text ? { table: table!, key: key!, text } : { table: table!, key: key! };
}

/** 지금 저장된 진행 상태(없으면 null) */
export function readState(db: Database, table: string): { hash: string; phase: string; done: number; backupPath: string | null } | null {
  if (!tableExists(db, STATE_TABLE)) return null;
  const row = db.prepare(`select plan_hash, phase, done, backup_path from ${STATE_TABLE} where tbl = ?`).get(table) as
    | { plan_hash: string; phase: string; done: bigint; backup_path: string | null }
    | undefined;
  return row ? { hash: row.plan_hash, phase: row.phase, done: Number(row.done), backupPath: row.backup_path } : null;
}

export function planMigration(db: Database, opts: MigrationOptions): MigrationPlan {
  const { info, decl: before } = requireDeclaration(db, opts.table);
  const notes: PlanNote[] = [];
  const vectors = vectorColumns(before);

  // ---- 1) 바꿀 벡터 열 고르기 ----
  let toColumn: VectorColumn | null = null;
  if (opts.to) {
    const parsed = parseUserColumn(opts.to, "--to");
    if (isTableOption(parsed) || parsed.kind !== "vector") throw planError("to-not-vector", `--to must be a vector column declaration: ${opts.to}`, { value: opts.to });
    toColumn = parsed;
  }
  const targetName = opts.column ?? toColumn?.name ?? (vectors.length === 1 ? vectors[0]!.name : undefined);
  if (!targetName) throw planError("choose-column", "table has several vector columns; choose one with --column");
  const oldVec = vectors.find((v) => v.name === targetName);
  if (!oldVec) throw planError("no-vector-column", `no vector column ${targetName} in ${opts.table}`, { column: targetName, table: opts.table });
  if (toColumn && toColumn.name !== targetName) {
    throw planError("rename-unsupported", `--to names ${toColumn.name} but the vector column is ${targetName} (renaming is not supported)`, { from: targetName, to: toColumn.name });
  }
  if (toColumn && opts.quantize) throw planError("to-and-quantize", "use either --to or --quantize, not both");

  let newVec: VectorColumn = toColumn ? { ...toColumn } : { ...oldVec, extra: [...oldVec.extra] };
  if (opts.quantize) {
    if (oldVec.elementType !== "float") {
      throw planError("quantize-needs-float", `--quantize needs a float vector column, ${targetName} is ${oldVec.elementType}`, { column: targetName, type: oldVec.elementType });
    }
    newVec = { ...newVec, elementType: opts.quantize, distanceMetric: opts.quantize === "bit" ? null : oldVec.distanceMetric };
  }
  if (newVec.elementType === "bit" && newVec.dims % 8 !== 0) throw planError("bit-dims", `bit vectors need dimensions divisible by 8, got ${newVec.dims}`, { dims: newVec.dims });

  // ---- 2) 작업 종류 정하기 ----
  let mode: MigrationMode;
  if (opts.reembed) {
    mode = "reembed";
    if (newVec.elementType !== "float") throw planError("reembed-float", "--reembed writes float vectors; quantize in a second migration");
    if (vectors.length > 1) throw planError("reembed-multi-vector", "--reembed supports tables with one vector column only");
    if (!opts.source?.text) throw planError("reembed-needs-text", "--reembed needs --source table:key:text (where the text to embed lives)");
  } else if (newVec.dims !== oldVec.dims) {
    throw planError("dims-need-reembed", `changing dimensions ${oldVec.dims} -> ${newVec.dims} needs new embeddings: add --reembed`, { from: oldVec.dims, to: newVec.dims });
  } else if (newVec.elementType !== oldVec.elementType) {
    if (oldVec.elementType !== "float") {
      throw planError("cannot-dequantize", `cannot convert ${oldVec.elementType} back to ${newVec.elementType}; re-embed instead`, { from: oldVec.elementType, to: newVec.elementType });
    }
    mode = "quantize";
  } else {
    mode = "copy";
  }

  // ---- 3) 열 추가·제거 ----
  const dropSet = new Set(opts.dropColumns ?? []);
  for (const name of dropSet) {
    const col = before.columns.find((c) => c.name === name);
    if (!col) throw planError("drop-missing", `--drop-column ${name}: no such column`, { column: name });
    if (col.kind === "vector" || col.kind === "primary-key") throw planError("drop-protected", `--drop-column ${name}: cannot drop the ${col.kind} column`, { column: name });
  }
  const added: Vec0Column[] = [];
  for (const text of opts.addColumns ?? []) {
    const parsed = parseUserColumn(text, "--add-column");
    if (isTableOption(parsed)) throw planError("add-option", `--add-column needs a column, got option ${text}`, { value: text });
    if (parsed.kind === "vector" || parsed.kind === "primary-key") throw planError("add-protected", `--add-column cannot add a ${parsed.kind} column`, { value: text });
    const clash = before.columns.some((c) => c.name.toLowerCase() === parsed.name.toLowerCase() && !dropSet.has(c.name));
    if (clash || added.some((c) => c.name.toLowerCase() === parsed.name.toLowerCase())) {
      throw planError("column-exists", `column ${parsed.name} already exists`, { column: parsed.name });
    }
    added.push(parsed);
  }
  const fill = opts.fill ?? {};
  for (const col of Object.keys(fill)) {
    if (!added.some((c) => c.name === col)) throw planError("fill-not-new", `--fill ${col}: only newly added columns can be filled`, { column: col });
  }
  for (const c of added) {
    // sqlite-vec 0.1.9 의 메타데이터 열은 NULL 을 받지 않는다(프로브: "Expected text ... received NULL")
    if (c.kind === "metadata" && !fill[c.name]) {
      throw planError("metadata-needs-fill", `new metadata column ${c.name} cannot be NULL in sqlite-vec 0.1.9; add --fill ${c.name}=<source column>`, { column: c.name });
    }
  }
  if (Object.keys(fill).length > 0 && !opts.source) throw planError("fill-needs-source", "--fill needs --source table:key");

  // ---- 4) 새 선언 ----
  const after: Vec0Declaration = {
    table: before.table,
    columns: [...before.columns.filter((c) => !dropSet.has(c.name)).map((c) => (c.name === targetName ? newVec : c)), ...added],
    options: before.options.map((o) => ({ ...o })),
  };
  const counts = countByKind(after);
  for (const kind of ["metadata", "partition", "auxiliary"] as const) {
    if (counts[kind] > LIMITS[kind]) {
      throw new Vec0KitError("E_LIMIT", `too many ${kind} columns: ${counts[kind]} > ${LIMITS[kind]}`, { kind, count: counts[kind], limit: LIMITS[kind] });
    }
  }
  const beforeSql = info.sql;
  const afterSql = formatVec0Declaration(after, opts.table);
  if (mode === "copy" && afterSql === formatVec0Declaration(before, opts.table)) {
    throw planError("nothing-to-change", "nothing to change: the new declaration equals the current one");
  }

  // ---- 5) 본문 테이블 확인 ----
  const source = opts.source ?? null;
  if (source) {
    if (!tableExists(db, source.table)) throw new Vec0KitError("E_NO_TABLE", `no source table ${source.table}`, { table: source.table });
    const cols = columnNames(db, source.table);
    for (const c of [source.key, source.text, ...Object.values(fill)]) {
      if (c && !cols.includes(c)) throw planError("source-column-missing", `no column ${c} in source table ${source.table}`, { column: c, table: source.table });
    }
  }

  // ---- 6) 복사 식 ----
  const key = keyColumn(before);
  const keyType = primaryKey(before)?.type ?? "integer";
  const v = (name: string) => `v.${quoteIdent(name)}`;
  const fromSource = (col: string) =>
    `(select d.${quoteIdent(col)} from ${quoteIdent(source!.table)} d where d.${quoteIdent(source!.key)} = v.${quoteIdent(key)})`;
  const columns: CopyColumn[] = [{ name: key, from: "key", expr: v(key) }];
  for (const c of after.columns) {
    if (c.kind === "primary-key") continue;
    if (c.name === targetName) {
      let expr = v(c.name);
      if (mode === "quantize") expr = newVec.elementType === "int8" ? `vec_quantize_int8(${v(c.name)}, 'unit')` : `vec_quantize_binary(${v(c.name)})`;
      columns.push({ name: c.name, from: mode === "reembed" ? "embed" : "transform", expr });
    } else if (added.includes(c)) {
      if (fill[c.name]) columns.push({ name: c.name, from: "source", expr: fromSource(fill[c.name]!), sourceColumn: fill[c.name]! });
      // fill 없는 새 파티션·보조 열은 NULL 로 둔다(INSERT 목록에서 뺀다)
    } else {
      columns.push({ name: c.name, from: "old", expr: v(c.name) });
    }
  }

  // ---- 7) 행 수·잘못된 벡터·고아 ----
  const rowCount = info.rowCount;
  const onInvalid = opts.onInvalid ?? "fail";
  const invalid: InvalidVectors[] = [];
  let orphansDropped = 0;
  let sourceRowsWithoutVector = 0;
  let rowsToProcess = rowCount;
  const metadataFromOldRow = columns.some((c) => c.from === "old" && after.columns.find((x) => x.name === c.name)?.kind === "metadata");
  if (mode === "reembed") {
    const k = countKeyDifferences(db, opts.table, key, source!);
    orphansDropped = k.orphans;
    sourceRowsWithoutVector = k.missing;
    rowsToProcess = k.sourceRows;
    if (orphansDropped > 0) notes.push({ key: "plan.note.orphans-dropped", params: { count: orphansDropped, source: source!.table } });
    if (sourceRowsWithoutVector > 0) {
      notes.push({
        key: metadataFromOldRow ? "plan.note.missing-skipped" : "plan.note.missing-added",
        params: { count: sourceRowsWithoutVector },
      });
    }
    if (opts.minRecall !== undefined) notes.push({ key: "plan.note.recall-informational", params: {} });
  } else {
    // 원본 벡터 점검: NaN/Inf 는 언제나, 0 벡터는 새 거리가 cosine 이면 잘못된 벡터
    const cosine = effectiveMetric(newVec) === "cosine";
    const found = findInvalid(db, opts.table, key, oldVec, cosine);
    invalid.push(...found);
    if (onInvalid === "skip") rowsToProcess = rowCount - found.reduce((n, f) => n + f.count, 0);
    if (mode === "quantize" && newVec.elementType === "int8") {
      const drift = countNotNormalized(db, opts.table, oldVec);
      if (drift > 0) notes.push({ key: "plan.note.int8-unit", params: { count: drift } });
    }
  }
  // 메타 열을 본문에서 채울 때 값이 비면(NULL) vec0 가 거부하므로 미리 세고, 원인(고아 벡터 / source 값 NULL)별로 rowid 예시를 모은다
  for (const c of added) {
    if (c.kind === "metadata" && fill[c.name] && source) {
      const src = quoteIdent(source.table);
      const sk = quoteIdent(source.key);
      const col = quoteIdent(fill[c.name]!);
      const vk = `v.${quoteIdent(key)}`;
      const vec = quoteIdent(opts.table);
      // 고아: source 에 키 행이 없는 벡터(reembed 는 고아를 이미 버리므로 해당 없음)
      const orphanWhere = mode === "reembed" ? null : `from ${vec} v where not exists (select 1 from ${src} d where d.${sk} = ${vk})`;
      // source 값 NULL: source 행은 있으나 채울 열이 NULL
      const nullWhere =
        mode === "reembed"
          ? `from ${src} d where d.${sk} is not null and d.${col} is null`
          : `from ${vec} v where exists (select 1 from ${src} d where d.${sk} = ${vk}) and ${fromSource(fill[c.name]!)} is null`;
      const nullKey = mode === "reembed" ? `d.${sk}` : vk;
      const count = (where: string) => Number((db.prepare(`select count(*) as c ${where}`).get() as { c: bigint }).c);
      const sampleOf = (k: string, where: string) =>
        (db.prepare(`select ${k} as k ${where} order by k limit ${FILL_SAMPLE_LIMIT}`).all() as { k: bigint | string }[]).map((r) => r.k);
      const orphans = orphanWhere ? count(orphanWhere) : 0;
      const nullValues = count(nullWhere);
      const nulls = orphans + nullValues;
      if (nulls > 0) {
        const orphanKeys = orphans > 0 ? sampleOf(vk, orphanWhere!) : [];
        const nullKeys = nullValues > 0 ? sampleOf(nullKey, nullWhere) : [];
        const reason = orphans > 0 && nullValues > 0 ? "fill-nulls-both" : orphans > 0 ? "fill-nulls-orphans" : "fill-nulls-values";
        throw new Vec0KitError(
          "E_PLAN",
          `${nulls} rows have no value for new metadata column ${c.name} (NULL is not allowed)`,
          {
            reason,
            column: c.name,
            count: nulls,
            orphans,
            orphanKeys: orphanKeys.map(String).join(", "),
            nullValues,
            nullKeys: nullKeys.map(String).join(", "),
            fillColumn: fill[c.name]!,
            source: source.table,
            sourceKey: source.key,
            table: opts.table,
          },
          { orphans: { count: orphans, sample: orphanKeys }, nullValues: { count: nullValues, sample: nullKeys } },
        );
      }
    }
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw usageError("bad-number", "--batch-size must be a positive integer", { option: "--batch-size" });
  const sample = opts.sample ?? 50;
  const k = opts.k ?? 10;
  if (!Number.isInteger(sample) || sample <= 0) throw usageError("bad-number", "--sample must be a positive integer", { option: "--sample" });
  if (!Number.isInteger(k) || k <= 0 || k > 4096) throw usageError("bad-k", "--k must be between 1 and 4096", { option: "--k" });
  if (opts.minRecall !== undefined && !(opts.minRecall >= 0 && opts.minRecall <= 1)) {
    throw usageError("bad-recall", "--min-recall must be between 0 and 1", { option: "--min-recall" });
  }

  // 예상 추가 디스크: 백업(파일 전체) + 임시 테이블 + 교체 때 한 번 더 복사
  const page = db.prepare("select page_count * page_size as b from pragma_page_count(), pragma_page_size()").get() as { b: bigint };
  const estimatedExtraBytes = Number(page.b) + 2 * rowsToProcess * (vectorBytes(newVec) + 16);

  const tempTable = tempTableName(opts.table);
  const embedderId = mode === "reembed" ? opts.reembed! : null;
  const hash = createHash("sha256")
    .update(JSON.stringify({ v: 1, table: opts.table, beforeSql, afterSql, mode, columns, source, embedderId }))
    .digest("hex")
    .slice(0, 16);

  // ---- 8) 이어서 하기 상태 ----
  const state = readState(db, opts.table);
  let resume: MigrationPlan["resume"] = null;
  if (state) {
    if (state.hash !== hash) {
      throw new Vec0KitError("E_RESUME_MISMATCH", `a different migration of ${opts.table} is in progress; rerun the same command or use --abort`, { table: opts.table });
    }
    resume = { done: state.done, phase: state.phase, backupPath: state.backupPath };
  } else if (tableExists(db, tempTable)) {
    throw planError("leftover-temp", `leftover temporary table ${tempTable} without migration state; run --abort first`, { table: tempTable });
  }

  return {
    table: opts.table,
    tempTable,
    mode,
    vectorColumn: targetName,
    keyColumn: key,
    keyType,
    before,
    after,
    beforeSql,
    afterSql,
    columns,
    source,
    embedderId,
    rowCount,
    rowsToProcess,
    batchSize,
    batches: mode === "reembed" ? Math.ceil(rowsToProcess / batchSize) : rowsToProcess > 0 ? 1 : 0,
    minRecall: opts.minRecall ?? null,
    sample,
    k,
    onInvalid,
    invalid,
    orphansDropped,
    sourceRowsWithoutVector,
    metadataFromOldRow,
    estimatedExtraBytes,
    notes,
    hash,
    resume,
  };
}

function findInvalid(db: Database, table: string, key: string, vec: VectorColumn, cosine: boolean): InvalidVectors[] {
  const zero: (bigint | string)[] = [];
  const nonFinite: (bigint | string)[] = [];
  const stmt = db.prepare(`select ${quoteIdent(key)} as k, ${quoteIdent(vec.name)} as e from ${quoteIdent(table)}`);
  for (const row of stmt.iterate() as Iterable<{ k: bigint | string; e: Uint8Array }>) {
    const s = vectorStats(row.e, vec.elementType);
    if (s.nonFinite) nonFinite.push(row.k);
    else if (s.isZero && cosine) zero.push(row.k);
  }
  const out: InvalidVectors[] = [];
  if (zero.length) out.push({ rule: "zero-vector", count: zero.length, keys: zero });
  if (nonFinite.length) out.push({ rule: "non-finite", count: nonFinite.length, keys: nonFinite });
  return out;
}

function countNotNormalized(db: Database, table: string, vec: VectorColumn): number {
  let n = 0;
  for (const row of db.prepare(`select ${quoteIdent(vec.name)} as e from ${quoteIdent(table)}`).iterate() as Iterable<{ e: Uint8Array }>) {
    const s = vectorStats(row.e, vec.elementType);
    if (!s.nonFinite && !s.isZero && Math.abs(s.norm - 1) > 1e-3) n++;
  }
  return n;
}

/** 재임베딩 계획용: 본문 행 수, 본문에 없는 벡터(고아), 벡터 없는 본문(누락) */
function countKeyDifferences(db: Database, table: string, key: string, source: SourceSpec): { sourceRows: number; orphans: number; missing: number } {
  const tmp = "temp._vec0kit_plan_keys";
  const src = quoteIdent(source.table);
  const sk = quoteIdent(source.key);
  db.exec(`drop table if exists ${tmp}; create table ${tmp}(k primary key)`);
  try {
    db.prepare(`insert into ${tmp}(k) select ${quoteIdent(key)} from ${quoteIdent(table)}`).run();
    const one = (sql: string) => Number((db.prepare(sql).get() as { c: bigint }).c);
    return {
      sourceRows: one(`select count(*) as c from ${src} d where d.${sk} is not null`),
      orphans: one(`select count(*) as c from ${tmp} t where not exists (select 1 from ${src} d where d.${sk} = t.k)`),
      missing: one(`select count(*) as c from ${src} d where d.${sk} is not null and not exists (select 1 from ${tmp} t where t.k = d.${sk})`),
    };
  } finally {
    db.exec(`drop table if exists ${tmp}`);
  }
}
