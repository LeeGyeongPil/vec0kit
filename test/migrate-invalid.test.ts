// AC-6: NaN·0 벡터 — 기본은 시작 전에 멈추고(파일 불변), --on-invalid skip 이면 빼고 진행
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, countRows, declarationOf, makeProblemDb, sha256, tempDir, withDb } from "./helpers/fixtures.js";

describe("AC-6 invalid vectors", () => {
  it("stops before changing anything when NaN / zero vectors would go into a cosine table", async () => {
    const dir = tempDir();
    const path = join(dir, "bad.db");
    makeProblemDb(path, "l2"); // zero: 1, NaN: 5, Inf: 6
    const before = sha256(path);

    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[8] distance_metric=cosine"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E_INVALID_VECTORS");
    expect(r.stderr).toContain("zero-vector: 1 (e.g. 1)");
    expect(r.stderr).toContain("non-finite: 2 (e.g. 5, 6)");
    expect(sha256(path)).toBe(before); // 파일이 한 바이트도 바뀌지 않았다
    expect(readdirSync(dir)).toEqual(["bad.db"]); // 백업도 만들지 않았다(시작 전에 멈춤)
  });

  it("only non-finite values block a migration that keeps l2 (zero vectors are fine there)", async () => {
    const path = join(tempDir(), "bad-l2.db");
    makeProblemDb(path, "l2");
    const r = await cli(["migrate", path, "--table", "vec_docs", "--drop-column", "note", "--no-backup", "--json"]);
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe("E_INVALID_VECTORS");
    expect(err.details.map((d: { rule: string }) => d.rule)).toEqual(["non-finite"]);
  });

  it("--on-invalid skip migrates the rest and reports the rowids it left out", async () => {
    const path = join(tempDir(), "skip.db");
    makeProblemDb(path, "l2");
    const original = countRows(path, "vec_docs"); // 21

    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[8] distance_metric=cosine", "--on-invalid", "skip", "--no-backup", "--json"]);
    expect(r.code).toBe(0);
    const { result } = JSON.parse(r.stdout);
    const skipped = Object.fromEntries(result.skipped.map((s: { rule: string; sample: number[]; count: number }) => [s.rule, s]));
    expect(skipped["zero-vector"]).toMatchObject({ count: 1, sample: [1] });
    expect(skipped["non-finite"]).toMatchObject({ count: 2, sample: [5, 6] });
    expect(result.rowsAfter).toBe(original - 3);
    expect(countRows(path, "vec_docs")).toBe(original - 3);
    expect(declarationOf(path, "vec_docs")).toContain("distance_metric=cosine");
    withDb(path, (db) => {
      const left = db.prepare("select rowid from vec_docs where rowid in (1, 5, 6)").all();
      expect(left).toEqual([]);
    });

    // 사람용 출력에도 빠진 rowid 가 보인다
    const path2 = join(tempDir(), "skip2.db");
    makeProblemDb(path2, "l2");
    const human = await cli(["migrate", path2, "--table", "vec_docs", "--to", "embedding float[8] distance_metric=cosine", "--on-invalid", "skip", "--no-backup"]);
    expect(human.stdout).toContain("zero-vector 1 (e.g. 1)");
    expect(human.stdout).toContain("non-finite 2 (e.g. 5, 6)");
  });
});
