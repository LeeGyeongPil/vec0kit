// AC-8: 계획(--dry-run)은 파일을 바꾸지 않고, 거부할 계획은 종료 2, 실제 이행은 원래 상태의 백업을 남긴다
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBackupPath } from "../src/cli.js";
import { cli, countRows, declarationOf, makeCleanDb, makeCorpusDb, sha256, tempDir, withDb } from "./helpers/fixtures.js";

describe("AC-8 plan and backup", () => {
  it("--dry-run prints before/after, mode, rows, batches and backup path, and leaves the file byte-identical", async () => {
    const dir = tempDir();
    const path = join(dir, "plan.db");
    makeCorpusDb(path, { dims: 64, rows: 200 });
    const before = sha256(path);

    const r = await cli([
      "migrate", path, "--table", "vec_docs", "--to", "embedding float[128]", "--reembed", "mock",
      "--source", "docs:id:body", "--batch-size", "50", "--backup", join(dir, "x.bak"), "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Migration plan (dry-run — nothing was changed)");
    expect(r.stdout).toMatch(/before\s+CREATE VIRTUAL TABLE vec_docs USING vec0\( ?embedding float\[64\]/);
    expect(r.stdout).toContain("after        CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[128]");
    expect(r.stdout).toContain("reembed (new embeddings from docs.body)");
    expect(r.stdout).toContain("practice mock");
    expect(r.stdout).toContain("200 to process (200 now in vec_docs)");
    expect(r.stdout).toContain("4 × up to 50 rows");
    expect(r.stdout).toContain(join(dir, "x.bak"));
    expect(sha256(path)).toBe(before);
    expect(existsSync(join(dir, "x.bak"))).toBe(false);

    const j = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "int8", "--no-backup", "--dry-run", "--json"]);
    const plan = JSON.parse(j.stdout);
    expect(plan.dryRun).toBe(true);
    expect(plan.plan).toMatchObject({ mode: "quantize", rowCount: 200, rowsToProcess: 200, batches: 1, tempTable: "vec_docs__vec0kit_new" });
    expect(plan.plan.afterSql).toBe("CREATE VIRTUAL TABLE vec_docs USING vec0(embedding int8[64] distance_metric=l2, topic text, +title text)");
    expect(sha256(path)).toBe(before);
  });

  it("rejects 17 metadata columns with E_LIMIT (exit 2)", async () => {
    const path = join(tempDir(), "limit.db");
    withDb(path, (db) => {
      const meta = Array.from({ length: 16 }, (_, i) => `m${i} integer`).join(", ");
      db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, extra INTEGER NOT NULL);
        CREATE VIRTUAL TABLE v USING vec0(embedding float[2], ${meta});
        INSERT INTO docs VALUES (1, 7);`);
    });
    const r = await cli(["migrate", path, "--table", "v", "--add-column", "m16 integer", "--fill", "m16=extra", "--source", "docs:id", "--no-backup", "--json"]);
    expect(r.code).toBe(2);
    const err = JSON.parse(r.stdout).error;
    expect(err.code).toBe("E_LIMIT");
    expect(err.params).toMatchObject({ kind: "metadata", count: 17, limit: 16 });
  });

  it("rejects a dimension change without --reembed with E_PLAN (exit 2)", async () => {
    const path = join(tempDir(), "dims.db");
    makeCleanDb(path);
    const before = sha256(path);
    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[16]", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "E_PLAN", reason: "dims-need-reembed" });
    expect(sha256(path)).toBe(before);
  });

  it("a real migration writes a backup that still has the old declaration and row count", async () => {
    const dir = tempDir();
    const path = join(dir, "real.db");
    makeCleanDb(path);
    const declBefore = declarationOf(path, "vec_docs");
    const backup = join(dir, "real.backup.db");
    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[8] distance_metric=cosine", "--backup", backup]);
    expect(r.code).toBe(0);
    expect(existsSync(backup)).toBe(true);
    expect(declarationOf(backup, "vec_docs")).toBe(declBefore);
    expect(countRows(backup, "vec_docs")).toBe(20);
    expect(declarationOf(path, "vec_docs")).toContain("distance_metric=cosine");

    // 같은 --backup 경로를 다시 주면 옛 백업을 덮어쓰지 않고 거부
    const again = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[8] distance_metric=l2", "--backup", backup]);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("already exists");
  });

  it("the default backup name never overwrites an earlier backup from the same second", () => {
    const dir = tempDir();
    const db = join(dir, "app.db");
    const now = new Date(2026, 10, 17, 9, 5, 7);
    const first = defaultBackupPath(db, now);
    expect(first).toBe(`${db}.vec0kit-20261117-090507.bak`);
    writeFileSync(first, "x");
    expect(defaultBackupPath(db, now)).toBe(`${db}.vec0kit-20261117-090507-2.bak`);
  });

  it("migrate without any change is a usage error", async () => {
    const path = join(tempDir(), "none.db");
    makeCleanDb(path);
    const r = await cli(["migrate", path, "--table", "vec_docs"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Tell migrate what to change");
  });
});
