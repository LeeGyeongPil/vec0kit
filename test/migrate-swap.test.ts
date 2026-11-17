// AC-3: 안전 교체(RENAME 없이): l2 → cosine + 메타 열 추가
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { planMigration } from "../src/plan.js";
import { cli, countRows, declarationOf, makeCleanDb, makeProblemDb, masterNames, tempDir, withDb } from "./helpers/fixtures.js";

type Row = { rowid: bigint; cat: string; note: string; embedding: Buffer };

function snapshot(path: string): Row[] {
  return withDb(path, (db) => db.prepare("select rowid, cat, note, embedding from vec_docs order by rowid").all() as Row[]);
}

describe("AC-3 safe swap without RENAME", () => {
  it("changes l2 → cosine and adds a metadata column, keeping rows, rowids and values", async () => {
    const dir = tempDir();
    const path = join(dir, "swap.db");
    makeCleanDb(path, "l2");
    const before = snapshot(path);

    // 실행되는 모든 SQL 을 기록한다
    const trace: string[] = [];
    const db = openDatabase(path, { trace: (sql) => trace.push(sql) });
    try {
      const plan = planMigration(db, {
        table: "vec_docs",
        to: "embedding float[8] distance_metric=cosine",
        addColumns: ["category text"],
        fill: { category: "category" },
        source: { table: "docs", key: "id" },
      });
      expect(plan.mode).toBe("copy");
      const result = await migrate(db, plan, { backupPath: join(dir, "swap.bak") });
      expect(result.verify.passed).toBe(true);
      expect(result.rowsAfter).toBe(20);
    } finally {
      db.close();
    }

    // 새 선언
    const sql = declarationOf(path, "vec_docs");
    expect(sql).toContain("distance_metric=cosine");
    expect(sql).toContain("category text");

    // 섀도 테이블은 모두 vec_docs_ 접두, 임시·상태 테이블 잔여 없음
    const names = masterNames(path);
    const others = names.filter((n) => n !== "docs" && n !== "vec_docs" && !n.startsWith("sqlite_"));
    expect(others.length).toBeGreaterThan(0);
    for (const n of others) expect(n.startsWith("vec_docs_")).toBe(true);
    expect(names.filter((n) => n.includes("__vec0kit") || n.includes("_vec0kit_migration"))).toEqual([]);

    // 닫았다 다시 열어도 KNN 이 된다(섀도 테이블 이름이 맞다는 뜻)
    const reopened = openDatabase(path, { readonly: true });
    try {
      const q = before[3]!.embedding;
      const knn = reopened.prepare("select rowid, distance from vec_docs where embedding match ? and k = 3").all(q) as { rowid: bigint; distance: number }[];
      expect(knn.length).toBe(3);
      expect(knn[0]!.rowid).toBe(before[3]!.rowid);
      // 새 메타 열이 본문 테이블 값으로 채워졌고 KNN 필터로 쓸 수 있다
      const filtered = reopened.prepare("select rowid from vec_docs where embedding match ? and k = 20 and category = 'blog'").all(q) as { rowid: bigint }[];
      expect(filtered.map((r) => r.rowid).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([3n, 6n, 9n, 12n, 15n, 18n]);
    } finally {
      reopened.close();
    }

    // 행 수·rowid 집합·기존 메타/보조 값·벡터 바이트 동일
    const after = snapshot(path);
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.rowid)).toEqual(before.map((r) => r.rowid));
    after.forEach((r, i) => {
      expect(r.cat).toBe(before[i]!.cat);
      expect(r.note).toBe(before[i]!.note);
      expect(Buffer.compare(r.embedding, before[i]!.embedding)).toBe(0);
    });

    // 실행된 SQL 에 RENAME 이 한 번도 없고, 교체는 DROP + 같은 이름 CREATE 로 했다
    expect(trace.filter((s) => /\bRENAME\b/i.test(s))).toEqual([]);
    expect(trace.some((s) => /^DROP TABLE vec_docs$/.test(s))).toBe(true);
    expect(trace.some((s) => /^CREATE VIRTUAL TABLE vec_docs USING vec0\(/.test(s))).toBe(true);
  });

  it("drops an auxiliary column through the CLI", async () => {
    const dir = tempDir();
    const path = join(dir, "drop.db");
    makeCleanDb(path, "l2");
    const r = await cli(["migrate", path, "--table", "vec_docs", "--drop-column", "note", "--no-backup"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Migrated vec_docs (copy)");
    expect(declarationOf(path, "vec_docs")).toBe("CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[8] distance_metric=l2, cat text)");
    expect(countRows(path, "vec_docs")).toBe(20);
  });

  it("refuses a new metadata column without --fill (sqlite-vec 0.1.9 metadata cannot be NULL)", async () => {
    const path = join(tempDir(), "nofill.db");
    makeCleanDb(path, "l2");
    const r = await cli(["migrate", path, "--table", "vec_docs", "--add-column", "lang text", "--no-backup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("E_PLAN");
    expect(r.stderr).toContain("--fill lang=");
  });

  it("adds a partition key without --fill (NULL is allowed there)", async () => {
    const path = join(tempDir(), "part.db");
    makeCleanDb(path, "l2");
    const r = await cli(["migrate", path, "--table", "vec_docs", "--add-column", "lang text partition key", "--no-backup"]);
    expect(r.code).toBe(0);
    expect(declarationOf(path, "vec_docs")).toContain("lang text partition key");
  });

  it("--fill explains orphan vectors with rowids and a fix (en and ko)", async () => {
    const path = join(tempDir(), "orphan.db");
    makeProblemDb(path, "l2"); // orphan vectors 101 and 102 have no docs row
    const args = ["migrate", path, "--table", "vec_docs", "--add-column", "year integer", "--fill", "year=id", "--source", "docs:id", "--on-invalid", "skip", "--dry-run"];
    const en = await cli([...args, "--lang", "en"]);
    expect(en.code).toBe(2);
    expect(en.stderr).toContain("E_PLAN");
    expect(en.stderr).toContain("101, 102");
    expect(en.stderr).toContain("orphans");
    expect(en.stderr).toContain("Fix:");
    expect(en.stderr).toContain("--source docs:id");
    const ko = await cli([...args, "--lang", "ko"]);
    expect(ko.code).toBe(2);
    expect(ko.stderr).toContain("101, 102");
    expect(ko.stderr).toContain("고아");
    expect(ko.stderr).toContain("고치는 법");
  });

  it("--fill explains NULL source values separately from orphans", async () => {
    const path = join(tempDir(), "nullsrc.db");
    makeCleanDb(path, "l2");
    withDb(path, (db) => db.exec("ALTER TABLE docs ADD COLUMN year INTEGER; UPDATE docs SET year = id WHERE id NOT IN (3, 4)"));
    const r = await cli(["migrate", path, "--table", "vec_docs", "--add-column", "year integer", "--fill", "year=year", "--source", "docs:id", "--dry-run", "--lang", "en"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("docs.year is NULL for 2 rows, e.g. 3, 4");
    expect(r.stderr).toContain("Fix:");
    expect(r.stderr).not.toContain("orphans");
  });
});
