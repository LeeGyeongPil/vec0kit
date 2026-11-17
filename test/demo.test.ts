// AC-10 일부: demo 가 문제를 심은 DB 를 만들고 inspect → check → migrate --dry-run 을 보여 준다
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { openDatabase } from "../src/db.js";
import { DEMO_PLANTED } from "../src/demo.js";
import { HANGUL, cli, tempDir } from "./helpers/fixtures.js";

describe("demo", () => {
  it("creates demo.db with the planted problems and prints the walkthrough (exit 0)", async () => {
    const dir = tempDir();
    const path = join(dir, "demo.db");
    const r = await cli(["demo", "--db", path]);
    expect(r.code).toBe(0);
    for (const s of ["vec_docs", "float[64]", "zero-vector", "non-finite", "orphan-vector", "missing-vector", "dry-run", "practice mock"]) {
      expect(r.stdout).toContain(s);
    }
    expect(r.stdout).toContain("check exited with 1");

    const db = openDatabase(path, { readonly: true });
    try {
      const report = check(db, { table: "vec_docs", source: { table: "docs", key: "id" } });
      const rules = Object.fromEntries(report.findings.map((f) => [f.rule, f]));
      expect(rules["zero-vector"]!.sample).toEqual([BigInt(DEMO_PLANTED.emptyDocId)]);
      expect(rules["non-finite"]!.sample).toEqual([BigInt(DEMO_PLANTED.nanDocId)]);
      expect(rules["missing-vector"]!.sample).toEqual([BigInt(DEMO_PLANTED.missingDocId)]);
      expect(rules["orphan-vector"]!.sample).toEqual(DEMO_PLANTED.orphanIds.map(BigInt));
    } finally {
      db.close();
    }

    // 다시 실행하면 자기가 만든 demo.db 는 새로 만든다
    expect((await cli(["demo", "--db", path])).code).toBe(0);
  });

  it("the suggested re-embed migration runs on the demo database", async () => {
    const path = join(tempDir(), "demo.db");
    await cli(["demo", "--db", path]);
    const r = await cli([
      "migrate", path, "--table", "vec_docs", "--to", "embedding float[128] distance_metric=cosine",
      "--reembed", "mock", "--source", "docs:id:body", "--batch-size", "50", "--on-invalid", "skip", "--no-backup", "--json",
    ]);
    expect(r.code).toBe(0);
    const { result } = JSON.parse(r.stdout);
    // 200 문서 − 벡터 없던 문서(메타를 옛 행에서 가져와야 함) 1 − 빈 문서(0 벡터) 1 = 198, 고아 2 는 옮기지 않음
    expect(result.rowsAfter).toBe(198);
    expect(result.orphansDropped).toBe(2);
    const skipped = Object.fromEntries(result.skipped.map((s: { rule: string; sample: number[] }) => [s.rule, s.sample]));
    expect(skipped["zero-vector"]).toEqual([DEMO_PLANTED.emptyDocId]);
    expect(skipped["missing-vector"]).toEqual([DEMO_PLANTED.missingDocId]);
  });

  it("refuses to overwrite a file it did not create (exit 2)", async () => {
    const path = join(tempDir(), "demo.db");
    writeFileSync(path, "not a database");
    const r = await cli(["demo", "--db", path]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not created by vec0kit demo");
  });

  it("speaks Korean with --lang ko", async () => {
    const r = await cli(["demo", "--db", join(tempDir(), "demo.db"), "--lang", "ko"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(HANGUL);
    expect(r.stdout).toContain("practice mock");
  });
});
