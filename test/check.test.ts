// AC-2: check 가 심은 문제를 규칙 ID 로 찾고, 종료 코드가 CI 에 맞다
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { openDatabase } from "../src/db.js";
import { cli, f32, makeCleanDb, makeProblemDb, sha256, tempDir, withDb } from "./helpers/fixtures.js";

function byRule(findings: { rule: string }[]) {
  return Object.fromEntries(findings.map((f) => [f.rule, f])) as unknown as Record<
    string,
    { count: number; sample: unknown[]; severity: string; params: Record<string, unknown> }
  >;
}

describe("AC-2 check", () => {
  it("finds every planted problem with the right rule id, count and sample rowids", async () => {
    const path = join(tempDir(), "problem.db");
    makeProblemDb(path, "cosine");
    const db = openDatabase(path, { readonly: true });
    try {
      const report = check(db, { table: "vec_docs", source: { table: "docs", key: "id" }, expectDim: 768 });
      const f = byRule(report.findings);
      expect(f["orphan-vector"]).toMatchObject({ count: 2, sample: [101n, 102n], severity: "error" });
      expect(f["missing-vector"]).toMatchObject({ count: 1, sample: [20n], severity: "error" });
      expect(f["zero-vector"]).toMatchObject({ count: 1, sample: [1n], severity: "error" }); // cosine → error
      expect(f["non-finite"]).toMatchObject({ count: 2, sample: [5n, 6n], severity: "error" });
      expect(f["dim-mismatch"]).toMatchObject({ severity: "error", params: expect.objectContaining({ expected: 768, actual: 8 }) });
      expect(f["untested-version"]).toBeUndefined(); // 0.1.9 이 로드됨
      expect(report.summary.rowsScanned).toBe(21);
    } finally {
      db.close();
    }
  });

  it("exits 1 on the problem DB and prints rule ids and fixes; exits 0 on a clean DB", async () => {
    const bad = join(tempDir(), "problem.db");
    makeProblemDb(bad, "cosine");
    const r = await cli(["check", bad, "--table", "vec_docs", "--source", "docs:id", "--expect-dim", "768"]);
    expect(r.code).toBe(1);
    for (const rule of ["orphan-vector", "missing-vector", "zero-vector", "non-finite", "dim-mismatch"]) expect(r.stdout).toContain(rule);
    expect(r.stdout).toContain("e.g. 101, 102");
    expect(r.stdout).toContain("Fix:");

    const good = join(tempDir(), "clean.db");
    makeCleanDb(good);
    const ok = await cli(["check", good, "--table", "vec_docs", "--source", "docs:id", "--expect-dim", "8"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("No problems found.");
    const okJson = JSON.parse((await cli(["check", good, "--json"])).stdout);
    expect(okJson.findings).toEqual([]);
  });

  it("reproduces why zero-vector is an error under cosine: the zero row comes first in KNN with a NULL distance", () => {
    const path = join(tempDir(), "problem.db");
    makeProblemDb(path, "cosine");
    withDb(path, (db) => {
      // 질의는 rowid 2 의 벡터 — 진짜 가장 가까운 이웃은 2 자신(거리 0)
      const q = (db.prepare("select embedding from vec_docs where rowid = 2").get() as { embedding: Buffer }).embedding;
      const rows = db.prepare("select rowid, distance from vec_docs where embedding match ? and k = 5").all(q) as { rowid: bigint; distance: number | null }[];
      expect(rows[0]).toEqual({ rowid: 1n, distance: null }); // 0 벡터(rowid 1)가 맨 앞
      expect(rows.some((r) => r.rowid === 2n && r.distance !== null && r.distance < 1e-6)).toBe(true);
    });
  });

  it("treats a zero vector as a warning under l2 and leaves the file untouched", async () => {
    const path = join(tempDir(), "problem-l2.db");
    makeProblemDb(path, "l2");
    const before = sha256(path);
    const r = await cli(["check", path, "--json"]);
    const f = byRule(JSON.parse(r.stdout).findings);
    expect(f["zero-vector"]!.severity).toBe("warn");
    expect(sha256(path)).toBe(before); // check 는 읽기만 한다
  });

  it("norm-drift is a warning; --strict turns warnings into exit 1", async () => {
    const path = join(tempDir(), "clean.db");
    makeCleanDb(path); // wave() 벡터는 정규화되어 있지 않다
    const loose = await cli(["check", path, "--expect-normalized"]);
    expect(loose.code).toBe(0);
    expect(loose.stdout).toContain("norm-drift");
    const strict = await cli(["check", path, "--expect-normalized", "--strict"]);
    expect(strict.code).toBe(1);
  });

  it("version-skew is info when the table was created by another sqlite-vec version", async () => {
    const path = join(tempDir(), "clean.db");
    makeCleanDb(path);
    withDb(path, (db) => {
      db.unsafeMode(true); // 섀도 테이블을 직접 고치는 건 테스트에서만
      db.prepare("update vec_docs_info set value = 'v0.1.6' where key = 'CREATE_VERSION'").run();
      db.unsafeMode(false);
    });
    const r = await cli(["check", path, "--json"]);
    expect(r.code).toBe(0);
    const f = byRule(JSON.parse(r.stdout).findings);
    expect(f["version-skew"]).toMatchObject({ severity: "info", params: expect.objectContaining({ created: "v0.1.6", loaded: "v0.1.9" }) });
  });

  it("checks text primary keys against the source table", async () => {
    const path = join(tempDir(), "text.db");
    withDb(path, (db) => {
      db.exec(`CREATE TABLE notes(slug TEXT PRIMARY KEY, body TEXT);
        CREATE VIRTUAL TABLE vec_notes USING vec0(slug text primary key, embedding float[2]);
        INSERT INTO notes VALUES ('a', 'x'), ('b', 'y');`);
      db.prepare("insert into vec_notes(slug, embedding) values (?, ?)").run("a", f32([1, 0]));
      db.prepare("insert into vec_notes(slug, embedding) values (?, ?)").run("zz", f32([0, 1]));
    });
    const r = await cli(["check", path, "--table", "vec_notes", "--source", "notes:slug", "--json"]);
    const f = byRule(JSON.parse(r.stdout).findings);
    expect(f["orphan-vector"]).toMatchObject({ count: 1, sample: ["zz"] });
    expect(f["missing-vector"]).toMatchObject({ count: 1, sample: ["b"] });
    expect(r.code).toBe(1);
  });

  it("--source without --table is a usage error (exit 2)", async () => {
    const path = join(tempDir(), "clean.db");
    makeCleanDb(path);
    const r = await cli(["check", path, "--source", "docs:id"]);
    expect(r.code).toBe(2);
  });
});
