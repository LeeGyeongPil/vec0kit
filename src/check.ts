// check: 벡터 테이블과 본문 테이블의 정합성 규칙 8종을 돌린다(읽기만 한다).
// 결과는 언어와 무관한 규칙 ID·메시지 키로 돌려주고, 사람용 번역은 CLI 가 한다.
import { type Database, TESTED_VEC_VERSION, columnNames, getVersions, quoteIdent, tableExists } from "./db.js";
import { type VectorColumn, effectiveMetric, keyColumn, vectorColumns } from "./declaration.js";
import { type MessageParams, Vec0KitError } from "./errors.js";
import { listVec0Tables, requireDeclaration } from "./inspect.js";
import { vectorStats } from "./vectors.js";

export type Severity = "error" | "warn" | "info";
export type RuleId =
  | "orphan-vector"
  | "missing-vector"
  | "zero-vector"
  | "non-finite"
  | "norm-drift"
  | "dim-mismatch"
  | "version-skew"
  | "untested-version";

export const RULES: readonly RuleId[] = [
  "orphan-vector",
  "missing-vector",
  "zero-vector",
  "non-finite",
  "norm-drift",
  "dim-mismatch",
  "version-skew",
  "untested-version",
];

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** 확장 버전처럼 DB 전체에 대한 것은 null */
  table: string | null;
  column: string | null;
  count: number;
  /** 문제 행의 키(rowid 는 BigInt, 텍스트 PK 는 문자열), 최대 10개 */
  sample: (bigint | string)[];
  messageKey: string;
  fixKey: string;
  params: MessageParams;
}

export interface SourceRef {
  table: string;
  key: string;
}

export interface CheckOptions {
  /** 생략하면 모든 vec0 테이블 */
  table?: string;
  /** 본문 테이블과 키 열 — 있으면 orphan-vector·missing-vector 를 본다 */
  source?: SourceRef;
  expectDim?: number;
  expectNormalized?: boolean;
  /** 벡터 열이 여러 개일 때 하나만 */
  column?: string;
}

export interface CheckReport {
  sqliteVecVersion: string;
  tables: string[];
  findings: Finding[];
  summary: { error: number; warn: number; info: number; rowsScanned: number };
}

const SAMPLE_LIMIT = 10;
const NORM_TOLERANCE = 1e-3;

function finding(
  rule: RuleId,
  severity: Severity,
  table: string | null,
  column: string | null,
  count: number,
  sample: (bigint | string)[],
  params: MessageParams = {},
): Finding {
  return {
    rule,
    severity,
    table,
    column,
    count,
    sample: sortKeys(sample).slice(0, SAMPLE_LIMIT),
    messageKey: `rule.${rule}.message`,
    fixKey: `rule.${rule}.fix`,
    params: { table: table ?? "", column: column ?? "", count, ...params },
  };
}

export function sortKeys(keys: (bigint | string)[]): (bigint | string)[] {
  return [...keys].sort((a, b) => {
    if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  });
}

export function check(db: Database, opts: CheckOptions = {}): CheckReport {
  const { sqliteVecVersion } = getVersions(db);
  if (opts.source && !opts.table) {
    throw new Vec0KitError("E_USAGE", "--source needs --table", { reason: "source-needs-table" });
  }
  const tables = opts.table ? [opts.table] : listVec0Tables(db).map((r) => r.name);
  const findings: Finding[] = [];
  let rowsScanned = 0;

  // 로드된 확장이 이 도구가 검증한 버전이 아니면 경고(DB 전체에 한 번)
  if (sqliteVecVersion !== TESTED_VEC_VERSION) {
    findings.push(finding("untested-version", "warn", null, null, 1, [], { loaded: sqliteVecVersion, tested: TESTED_VEC_VERSION }));
  }

  for (const table of tables) {
    const { info, decl } = requireDeclaration(db, table);
    const key = keyColumn(decl);
    let vectors = vectorColumns(decl);
    if (opts.column) {
      vectors = vectors.filter((v) => v.name === opts.column);
      if (vectors.length === 0) throw new Vec0KitError("E_USAGE", `no vector column ${opts.column} in ${table}`, { reason: "no-vector-column", column: opts.column, table });
    }

    // version-skew: 테이블을 만든 버전과 지금 로드한 버전이 다르다(참고)
    if (info.createVersion && info.createVersion !== sqliteVecVersion) {
      findings.push(finding("version-skew", "info", table, null, 1, [], { created: info.createVersion, loaded: sqliteVecVersion }));
    }

    // dim-mismatch: 선언 차원이 기대와 다르다(모델을 바꿨는데 테이블은 그대로인 경우)
    if (opts.expectDim !== undefined) {
      for (const v of vectors) {
        if (v.dims !== opts.expectDim) {
          findings.push(finding("dim-mismatch", "error", table, v.name, info.rowCount, [], { expected: opts.expectDim, actual: v.dims }));
        }
      }
    }

    // 벡터 값 훑기: 0 벡터·비유한 값·노름 — 스트리밍으로 읽어 메모리를 일정하게 유지
    const scan = scanVectors(db, table, key, vectors, opts.expectNormalized ?? false);
    rowsScanned += scan.rows;
    for (const v of vectors) {
      const s = scan.byColumn.get(v.name)!;
      if (s.zero.count > 0) {
        // cosine 에서 0 벡터는 distance 가 NULL — KNN 결과에 섞여 들어가므로 error
        const sev: Severity = effectiveMetric(v) === "cosine" ? "error" : "warn";
        findings.push(finding("zero-vector", sev, table, v.name, s.zero.count, s.zero.sample, { metric: effectiveMetric(v) }));
      }
      if (s.nonFinite.count > 0) findings.push(finding("non-finite", "error", table, v.name, s.nonFinite.count, s.nonFinite.sample));
      if (s.normDrift.count > 0) findings.push(finding("norm-drift", "warn", table, v.name, s.normDrift.count, s.normDrift.sample, { tolerance: NORM_TOLERANCE }));
    }

    // orphan-vector·missing-vector: 본문 테이블과 키 비교
    if (opts.source) findings.push(...compareWithSource(db, table, key, opts.source));
  }

  const summary = { error: 0, warn: 0, info: 0, rowsScanned };
  for (const f of findings) summary[f.severity]++;
  return { sqliteVecVersion, tables, findings, summary };
}

interface Bucket {
  count: number;
  sample: (bigint | string)[];
}

function add(bucket: Bucket, key: bigint | string): void {
  bucket.count++;
  if (bucket.sample.length < SAMPLE_LIMIT) bucket.sample.push(key);
}

export function scanVectors(
  db: Database,
  table: string,
  key: string,
  vectors: VectorColumn[],
  expectNormalized: boolean,
): { rows: number; byColumn: Map<string, { zero: Bucket; nonFinite: Bucket; normDrift: Bucket }> } {
  const byColumn = new Map<string, { zero: Bucket; nonFinite: Bucket; normDrift: Bucket }>();
  for (const v of vectors) byColumn.set(v.name, { zero: { count: 0, sample: [] }, nonFinite: { count: 0, sample: [] }, normDrift: { count: 0, sample: [] } });
  if (vectors.length === 0) return { rows: 0, byColumn };
  const cols = vectors.map((v) => quoteIdent(v.name)).join(", ");
  const stmt = db.prepare(`select ${quoteIdent(key)} as k, ${cols} from ${quoteIdent(table)}`);
  let rows = 0;
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    rows++;
    const k = row.k as bigint | string;
    for (const v of vectors) {
      const blob = row[v.name] as Uint8Array;
      const s = vectorStats(blob, v.elementType);
      const b = byColumn.get(v.name)!;
      if (s.nonFinite) add(b.nonFinite, k);
      else if (s.isZero) add(b.zero, k);
      else if (expectNormalized && v.elementType === "float" && Math.abs(s.norm - 1) > NORM_TOLERANCE) add(b.normDrift, k);
    }
  }
  return { rows, byColumn };
}

/** 본문 테이블과 키 집합을 비교한다. vec0 의 키를 임시 테이블에 옮겨 인덱스로 조인한다(큰 테이블에서도 O(n log n)). */
function compareWithSource(db: Database, table: string, key: string, source: SourceRef): Finding[] {
  if (!tableExists(db, source.table)) throw new Vec0KitError("E_NO_TABLE", `no source table ${source.table}`, { table: source.table });
  if (!columnNames(db, source.table).includes(source.key)) {
    throw new Vec0KitError("E_USAGE", `no column ${source.key} in ${source.table}`, { reason: "source-column-missing", column: source.key, table: source.table });
  }
  const tmp = "temp._vec0kit_check_keys";
  const src = quoteIdent(source.table);
  const sk = quoteIdent(source.key);
  db.exec(`drop table if exists ${tmp}; create table ${tmp}(k primary key)`);
  try {
    db.prepare(`insert into ${tmp}(k) select ${quoteIdent(key)} from ${quoteIdent(table)}`).run();
    const orphanWhere = `from ${tmp} t where not exists (select 1 from ${src} d where d.${sk} = t.k)`;
    const missingWhere = `from ${src} d where d.${sk} is not null and not exists (select 1 from ${tmp} t where t.k = d.${sk})`;
    const out: Finding[] = [];
    const orphanCount = Number((db.prepare(`select count(*) as c ${orphanWhere}`).get() as { c: bigint }).c);
    if (orphanCount > 0) {
      const sample = (db.prepare(`select t.k as k ${orphanWhere} order by t.k limit ${SAMPLE_LIMIT}`).all() as { k: bigint | string }[]).map((r) => r.k);
      out.push(finding("orphan-vector", "error", table, null, orphanCount, sample, { source: source.table }));
    }
    const missingCount = Number((db.prepare(`select count(*) as c ${missingWhere}`).get() as { c: bigint }).c);
    if (missingCount > 0) {
      const sample = (db.prepare(`select d.${sk} as k ${missingWhere} order by d.${sk} limit ${SAMPLE_LIMIT}`).all() as { k: bigint | string }[]).map((r) => r.k);
      out.push(finding("missing-vector", "error", table, null, missingCount, sample, { source: source.table }));
    }
    return out;
  } finally {
    db.exec(`drop table if exists ${tmp}`);
  }
}

/** CI 용 종료 코드: error 가 있으면 1, --strict 면 warn 도 1, info 는 영향 없음 */
export function exitCodeForReport(report: CheckReport, strict = false): number {
  if (report.summary.error > 0) return 1;
  if (strict && report.summary.warn > 0) return 1;
  return 0;
}
