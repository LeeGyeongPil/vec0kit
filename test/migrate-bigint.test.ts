// AC-4: BigInt 보존 — 2^53+1 rowid·INTEGER 메타 값과 텍스트 PK 가 이행 뒤에도 정확히 같다
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { createMockEmbedder } from "../src/embedders/mock.js";
import { migrate } from "../src/migrate.js";
import { planMigration } from "../src/plan.js";
import { cli, declarationOf, f32, tempDir, wave, withDb } from "./helpers/fixtures.js";

const BIG = 9007199254740993n; // 2^53 + 1 — JS number 로는 9007199254740992 가 된다
const MAX = 9223372036854775807n; // int64 최댓값

describe("AC-4 BigInt and text keys survive a migration", () => {
  it("keeps rowid 2^53+1 and INTEGER metadata 2^53+1 exactly (copy path)", async () => {
    expect(Number(BIG)).not.toBe(BIG); // 전제: number 로 바꾸면 값이 바뀐다
    const dir = tempDir();
    const path = join(dir, "big.db");
    const keys = [1n, 2n, BIG, MAX];
    withDb(path, (db) => {
      db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[4], n integer, +label text)");
      const ins = db.prepare("insert into v(rowid, embedding, n, label) values (?, ?, ?, ?)");
      keys.forEach((k, i) => ins.run(k, f32(wave(i + 1, 4)), k === 2n ? BIG : BigInt(i), `row ${k}`));
    });

    const r = await cli(["migrate", path, "--table", "v", "--to", "embedding float[4] distance_metric=cosine", "--no-backup", "--json"]);
    expect(r.code).toBe(0);
    expect(declarationOf(path, "v")).toContain("distance_metric=cosine");

    withDb(path, (db) => {
      const rows = db.prepare("select rowid, n, label from v order by rowid").all() as { rowid: bigint; n: bigint; label: string }[];
      expect(rows.map((x) => x.rowid)).toEqual(keys);
      expect(rows.find((x) => x.rowid === 2n)!.n === BIG).toBe(true);
      expect(rows.find((x) => x.rowid === BIG)!.label).toBe(`row ${BIG}`);
      expect(typeof rows[0]!.rowid).toBe("bigint");
    });
    // JSON 출력도 정밀도를 잃지 않는다(안전 범위를 넘으면 문자열)
    expect(r.stdout).not.toContain("9007199254740992");
  });

  it("keeps BigInt keys on the re-embed path, which reads and writes keys in JavaScript", async () => {
    const path = join(tempDir(), "big-reembed.db");
    withDb(path, (db) => {
      db.exec(`CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT);
        CREATE VIRTUAL TABLE v USING vec0(embedding float[4], n integer);`);
      for (const [k, body] of [[1n, "alpha beta"], [BIG, "gamma delta"], [MAX, "beta gamma"]] as const) {
        db.prepare("insert into docs(id, body) values (?, ?)").run(k, body);
        db.prepare("insert into v(rowid, embedding, n) values (?, ?, ?)").run(k, f32(wave(Number(k % 7n), 4)), k);
      }
    });
    const db = openDatabase(path);
    try {
      const embedder = createMockEmbedder({ dims: 8 });
      const plan = planMigration(db, { table: "v", to: "embedding float[8]", reembed: embedder.id!, source: { table: "docs", key: "id", text: "body" } });
      const result = await migrate(db, plan, { embedder });
      expect(result.rowsAfter).toBe(3);
      const rows = db.prepare("select rowid, n from v order by rowid").all() as { rowid: bigint; n: bigint }[];
      expect(rows.map((x) => x.rowid)).toEqual([1n, BIG, MAX]);
      expect(rows.map((x) => x.n)).toEqual([1n, BIG, MAX]);
    } finally {
      db.close();
    }
  });

  it("migrates a table with a text primary key (doc_id text primary key)", async () => {
    const path = join(tempDir(), "text.db");
    const ids = ["doc-a", "doc-b", "문서-c", "doc d"];
    withDb(path, (db) => {
      db.exec("CREATE VIRTUAL TABLE t USING vec0(doc_id text primary key, embedding float[8], cat text)");
      const ins = db.prepare("insert into t(doc_id, embedding, cat) values (?, ?, ?)");
      ids.forEach((id, i) => ins.run(id, f32(wave(i + 2, 8)), i % 2 ? "x" : "y"));
    });
    const r = await cli(["migrate", path, "--table", "t", "--quantize", "int8", "--no-backup"]);
    expect(r.code).toBe(0);
    expect(declarationOf(path, "t")).toBe("CREATE VIRTUAL TABLE t USING vec0(doc_id text primary key, embedding int8[8], cat text)");
    withDb(path, (db) => {
      const rows = db.prepare("select doc_id, cat from t order by doc_id").all() as { doc_id: string; cat: string }[];
      expect(rows.map((x) => x.doc_id)).toEqual([...ids].sort());
      expect(rows.find((x) => x.doc_id === "문서-c")!.cat).toBe("y");
    });
  });
});
