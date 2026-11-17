// AC-5: 양자화와 recall 게이트 — 기준 미달이면 교체하지 않고, --abort 로 잔여 없이 지운다
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cli, countRows, declarationOf, makeCorpusDb, masterNames, tempDir } from "./helpers/fixtures.js";

describe("AC-5 quantization and the recall gate", () => {
  it.each(["int8", "bit"] as const)("quantizes float[64] (200 rows) to %s and reports recall@10 between 0 and 1", async (type) => {
    const path = join(tempDir(), `q-${type}.db`);
    makeCorpusDb(path, { dims: 64, rows: 200 });
    const r = await cli(["migrate", path, "--table", "vec_docs", "--quantize", type, "--no-backup", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    const recall = out.result.verify.recall;
    expect(recall.k).toBe(10);
    expect(recall.queries).toBe(50);
    expect(recall.value).toBeGreaterThanOrEqual(0);
    expect(recall.value).toBeLessThanOrEqual(1);
    expect(recall.gated).toBe(false);
    expect(declarationOf(path, "vec_docs")).toContain(`embedding ${type}[64]`);
    expect(countRows(path, "vec_docs")).toBe(200);
    if (type === "int8") expect(recall.value).toBeGreaterThan(0.8); // int8 은 거의 그대로
  });

  it("refuses to swap when bit recall is below --min-recall 0.99, keeps the temp table, and --abort removes it", async () => {
    const dir = tempDir();
    const path = join(dir, "gate.db");
    makeCorpusDb(path, { dims: 64, rows: 200 });
    const declBefore = declarationOf(path, "vec_docs");

    const r = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "bit", "--min-recall", "0.99", "--backup", join(dir, "gate.bak")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E_VERIFY");
    expect(r.stderr).toMatch(/recall@10 0\.\d{3} over 50 queries \(gate ≥ 0\.99\) FAILED/);

    // 원본 그대로, 임시 테이블은 남아 있다
    expect(declarationOf(path, "vec_docs")).toBe(declBefore);
    expect(countRows(path, "vec_docs")).toBe(200);
    expect(masterNames(path)).toContain("vec_docs__vec0kit_new");
    expect(masterNames(path)).toContain("_vec0kit_migration");

    // 같은 명령을 다시 실행해도 같은 이유로 멈춘다(이어서 하기 → 검증 단계)
    copyFileSync(path, join(dir, "gate-copy.db"));
    const again = await cli(["migrate", join(dir, "gate-copy.db"), "--table", "vec_docs", "--quantize", "bit", "--min-recall", "0.99", "--no-backup"]);
    expect(again.code).toBe(1);

    // --abort 뒤에는 잔여가 없다
    const abort = await cli(["migrate", path, "--table", "vec_docs", "--abort"]);
    expect(abort.code).toBe(0);
    expect(abort.stdout).toContain("Removed the unfinished migration of vec_docs");
    const names = masterNames(path);
    expect(names.filter((n) => n.includes("__vec0kit") || n.includes("_vec0kit_migration"))).toEqual([]);
    expect(declarationOf(path, "vec_docs")).toBe(declBefore);
    expect(countRows(path, "vec_docs")).toBe(200);

    // 두 번째 --abort 는 할 일이 없다
    const second = await cli(["migrate", path, "--table", "vec_docs", "--abort"]);
    expect(second.stdout).toContain("Nothing to abort");
  });

  it("a lower --min-recall on the rerun passes verification and swaps (recall gate is not part of the resume hash)", async () => {
    const path = join(tempDir(), "gate2.db");
    makeCorpusDb(path, { dims: 64, rows: 200 });
    const first = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "bit", "--min-recall", "0.99", "--no-backup"]);
    expect(first.code).toBe(1);
    const second = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "bit", "--min-recall", "0.3", "--no-backup"]);
    expect(second.code).toBe(0);
    expect(declarationOf(path, "vec_docs")).toContain("embedding bit[64]");
    expect(masterNames(path).filter((n) => n.includes("vec0kit"))).toEqual([]);
  });

  it("rejects bit quantization when dimensions are not a multiple of 8", async () => {
    const path = join(tempDir(), "odd.db");
    makeCorpusDb(path, { dims: 12, rows: 20 });
    const r = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "bit", "--no-backup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("divisible by 8");
  });
});
