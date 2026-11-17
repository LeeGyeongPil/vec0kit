// 앱이 DB 를 쓰는 중이면(쓰기 잠금) 아무것도 바꾸지 않고 E_LOCKED 로 멈춘다
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { abortMigration, migrate } from "../src/migrate.js";
import { planMigration } from "../src/plan.js";
import { makeCleanDb, masterNames, sha256, tempDir } from "./helpers/fixtures.js";

describe("locked database", () => {
  it("migrate stops with E_LOCKED while another connection holds a write lock, and changes nothing", async () => {
    const path = join(tempDir(), "locked.db");
    makeCleanDb(path);
    const before = sha256(path);

    const app = new Database(path); // 앱 역할: 쓰기 트랜잭션을 쥐고 있다
    app.exec("BEGIN IMMEDIATE");
    const db = openDatabase(path, { busyTimeoutMs: 50 });
    try {
      const plan = planMigration(db, { table: "vec_docs", to: "embedding float[8] distance_metric=cosine" });
      await expect(migrate(db, plan)).rejects.toMatchObject({ code: "E_LOCKED" });
      expect(() => abortMigration(db, "vec_docs")).toThrowError(expect.objectContaining({ code: "E_LOCKED" }));
    } finally {
      db.close();
      app.exec("ROLLBACK");
      app.close();
    }
    expect(sha256(path)).toBe(before);
    expect(masterNames(path).filter((n) => n.includes("vec0kit"))).toEqual([]);
  });
});
