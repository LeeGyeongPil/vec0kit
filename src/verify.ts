// verify: 임시 테이블이 옛 테이블을 대신해도 되는지 확인한다(교체 전에 실행).
// ① 행 수 ② 키 집합 해시 ③ 메타·보조 값 표본 비교 ④ 표본 KNN recall@k
import { createHash } from "node:crypto";
import { type Database, quoteIdent } from "./db.js";
import { type ElementType, vectorColumns } from "./declaration.js";
import type { MigrationPlan } from "./plan.js";
import { SKIPPED_TABLE } from "./plan.js";
import { vectorStats } from "./vectors.js";

export interface VerifyReport {
  passed: boolean;
  /** 실패한 검사 이름: row-count | keys | values | recall */
  failures: string[];
  rowCount: { expected: number; actual: number; ok: boolean };
  keys: { expectedHash: string; actualHash: string; ok: boolean };
  values: { checked: number; mismatches: number; sample: { key: bigint | string; column: string }[]; ok: boolean };
  recall: {
    k: number;
    queries: number;
    /** 0~1. 재임베딩이면 "이웃 일치도"(참고값) */
    value: number | null;
    /** true 면 min 미만일 때 교체하지 않는다(재임베딩은 다른 모델이라 false) */
    gated: boolean;
    /** 재임베딩: 다른 모델의 이웃과 비교한 "이웃 일치도"(참고값) */
    neighbourAgreement: boolean;
    min: number | null;
    ok: boolean;
  };
}

/** 키를 타입까지 구분해 해시에 넣는다(정수 1 과 문자열 "1" 은 다른 키). */
function hashKeys(keys: Iterable<bigint | string>): { hash: string; count: number } {
  const h = createHash("sha256");
  let count = 0;
  for (const k of keys) {
    h.update(typeof k === "bigint" ? `i:${k}\n` : `t:${String(k)}\n`);
    count++;
  }
  return { hash: h.digest("hex").slice(0, 16), count };
}

function* column<T>(rows: Iterable<unknown>, name: string): Generator<T> {
  for (const r of rows) yield (r as Record<string, T>)[name] as T;
}

/** 옛 벡터 BLOB 을 MATCH 에 넘기는 식: int8·bit BLOB 은 타입 표시 함수로 감싼다 */
function matchExpr(elementType: ElementType): string {
  if (elementType === "int8") return "vec_int8(?)";
  if (elementType === "bit") return "vec_bit(?)";
  return "?";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) return Buffer.compare(a, b) === 0;
  return typeof a === typeof b && a === b;
}

export function verifyMigration(db: Database, plan: MigrationPlan): VerifyReport {
  const key = quoteIdent(plan.keyColumn);
  const old = quoteIdent(plan.table);
  const tmp = quoteIdent(plan.tempTable);
  const skippedFilter = `not in (select k from ${SKIPPED_TABLE} where tbl = '${plan.table.replaceAll("'", "''")}')`;
  const failures: string[] = [];

  // ① ② 기대 키 집합: copy·quantize 는 옛 테이블 − 건너뛴 행, reembed 는 본문 테이블 − 건너뛴 행
  const expectedSql =
    plan.mode === "reembed"
      ? `select d.${quoteIdent(plan.source!.key)} as k from ${quoteIdent(plan.source!.table)} d where d.${quoteIdent(plan.source!.key)} is not null and d.${quoteIdent(plan.source!.key)} ${skippedFilter} order by 1`
      : `select v.${key} as k from ${old} v where v.${key} ${skippedFilter} order by 1`;
  const expected = hashKeys(column<bigint | string>(db.prepare(expectedSql).iterate(), "k"));
  const actual = hashKeys(column<bigint | string>(db.prepare(`select ${key} as k from ${tmp} order by 1`).iterate(), "k"));
  const rowCount = { expected: expected.count, actual: actual.count, ok: expected.count === actual.count };
  const keys = { expectedHash: expected.hash, actualHash: actual.hash, ok: expected.hash === actual.hash };
  if (!rowCount.ok) failures.push("row-count");
  if (!keys.ok) failures.push("keys");

  // 표본 키: 임시 테이블 키를 정렬해 고르게 sample 개
  const total = actual.count;
  const step = Math.max(1, Math.floor(total / plan.sample));
  const sampleKeys: (bigint | string)[] = [];
  let i = 0;
  for (const k of column<bigint | string>(db.prepare(`select ${key} as k from ${tmp} order by 1`).iterate(), "k")) {
    if (i++ % step === 0 && sampleKeys.length < plan.sample) sampleKeys.push(k);
  }

  // ③ 옛 테이블에서 그대로 옮긴 열(메타·파티션·보조·다른 벡터)이 같은지
  const keptColumns = plan.columns.filter((c) => c.from === "old").map((c) => c.name);
  const values = { checked: 0, mismatches: 0, sample: [] as { key: bigint | string; column: string }[], ok: true };
  if (keptColumns.length > 0) {
    const cols = keptColumns.map(quoteIdent).join(", ");
    const readOld = db.prepare(`select ${cols} from ${old} where ${key} = ?`);
    const readNew = db.prepare(`select ${cols} from ${tmp} where ${key} = ?`);
    for (const k of sampleKeys) {
      const a = readOld.get(k) as Record<string, unknown> | undefined;
      const b = readNew.get(k) as Record<string, unknown> | undefined;
      if (!a || !b) continue; // reembed 의 새 행은 옛 값이 없다
      values.checked++;
      for (const c of keptColumns) {
        if (!sameValue(a[c], b[c])) {
          values.mismatches++;
          if (values.sample.length < 10) values.sample.push({ key: k, column: c });
        }
      }
    }
    values.ok = values.mismatches === 0;
    if (!values.ok) failures.push("values");
  }

  // ④ 표본 KNN recall@k: 같은 질의로 옛 테이블과 임시 테이블의 top-k 가 얼마나 겹치는지
  const oldVec = vectorColumns(plan.before).find((v) => v.name === plan.vectorColumn)!;
  const newVec = vectorColumns(plan.after).find((v) => v.name === plan.vectorColumn)!;
  const col = quoteIdent(plan.vectorColumn);
  const k = Math.max(1, Math.min(plan.k, total));
  const skipped = new Set(
    (db.prepare(`select k from ${SKIPPED_TABLE} where tbl = ?`).all(plan.table) as { k: bigint | string }[]).map((r) => String(r.k)),
  );
  // 옛 쪽은 건너뛴 행이 섞여 나올 수 있어(0 벡터의 NULL 거리) 여유 있게 받아 걸러낸다
  const oldK = Math.min(4096, k + skipped.size);
  const knnOld = db.prepare(`select ${key} as k from ${old} where ${col} match ${matchExpr(oldVec.elementType)} and k = ${oldK}`);
  let newMatch = matchExpr(newVec.elementType);
  if (plan.mode === "quantize") newMatch = newVec.elementType === "int8" ? "vec_quantize_int8(?, 'unit')" : "vec_quantize_binary(?)";
  const knnNew = db.prepare(`select ${key} as k from ${tmp} where ${col} match ${newMatch} and k = ${k}`);
  const readOldVec = db.prepare(`select ${col} as e from ${old} where ${key} = ?`);
  const readNewVec = db.prepare(`select ${col} as e from ${tmp} where ${key} = ?`);

  let sum = 0;
  let queries = 0;
  if (total > 0) {
    for (const qk of sampleKeys) {
      const oldRow = readOldVec.get(qk) as { e: Uint8Array } | undefined;
      if (!oldRow) continue;
      const s = vectorStats(oldRow.e, oldVec.elementType);
      if (s.nonFinite || s.isZero) continue;
      // 재임베딩은 새 공간의 벡터로 새 테이블을 질의한다(같은 행의 이웃이 비슷한지 = 참고값)
      let newQuery: Uint8Array = oldRow.e;
      if (plan.mode === "reembed") {
        const n = readNewVec.get(qk) as { e: Uint8Array } | undefined;
        if (!n) continue;
        newQuery = n.e;
      }
      const a = (knnOld.all(oldRow.e) as { k: bigint | string }[]).map((r) => String(r.k)).filter((x) => !skipped.has(x)).slice(0, k);
      const b = new Set((knnNew.all(newQuery) as { k: bigint | string }[]).map((r) => String(r.k)));
      sum += a.filter((x) => b.has(x)).length / k;
      queries++;
    }
  }
  const value = queries > 0 ? sum / queries : null;
  const gated = plan.mode !== "reembed" && plan.minRecall !== null;
  const recallOk = !gated || (value !== null && value >= plan.minRecall!);
  if (!recallOk) failures.push("recall");

  return {
    passed: failures.length === 0,
    failures,
    rowCount,
    keys,
    values,
    recall: { k, queries, value, gated, neighbourAgreement: plan.mode === "reembed", min: plan.minRecall, ok: recallOk },
  };
}
