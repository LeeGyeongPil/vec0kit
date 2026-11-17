// AC-1: inspect 가 vec0 선언을 정확히 파싱하고, 모르면 추측하지 않고 E_PARSE
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatVec0Declaration, parseVec0Declaration } from "../src/declaration.js";
import { Vec0KitError } from "../src/errors.js";
import { cli, f32, tempDir, wave, withDb } from "./helpers/fixtures.js";

function makeThreeTables(path: string): void {
  withDb(path, (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE v_float USING vec0(
        embedding float[8] distance_metric=cosine,
        chunk_size=64,
        lang text partition key,
        year integer,
        +title text
      );
      CREATE VIRTUAL TABLE v_int8 USING vec0(id integer primary key, embedding int8[16], cat text);
      CREATE VIRTUAL TABLE v_bit USING vec0(doc_id text primary key, embedding bit[64], +note text);`);
    const a = db.prepare("insert into v_float(rowid, embedding, lang, year, title) values (?, ?, ?, ?, ?)");
    for (let i = 1n; i <= 3n; i++) a.run(i, f32(wave(Number(i), 8)), "en", 2024n, `t${i}`);
    const b = db.prepare("insert into v_int8(id, embedding, cat) values (?, vec_quantize_int8(?, 'unit'), ?)");
    for (let i = 1n; i <= 2n; i++) b.run(i, f32(wave(Number(i), 16).map((x) => x / 4)), "c");
    db.prepare("insert into v_bit(doc_id, embedding, note) values (?, vec_quantize_binary(?), ?)").run("doc-a", f32(wave(1, 64)), "n");
  });
}

describe("AC-1 inspect", () => {
  it("parses three fixture declarations into the expected JSON", async () => {
    const db = join(tempDir(), "three.db");
    makeThreeTables(db);
    const r = await cli(["inspect", db, "--json"]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.sqliteVecVersion).toBe("v0.1.9");
    expect(report.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
    const byName = Object.fromEntries(report.tables.map((t: { name: string }) => [t.name, t]));

    expect(byName.v_float).toMatchObject({
      name: "v_float",
      rowCount: 3,
      createVersion: "v0.1.9",
      parseError: null,
      declaration: {
        table: "v_float",
        columns: [
          { kind: "vector", name: "embedding", elementType: "float", dims: 8, distanceMetric: "cosine", extra: [] },
          { kind: "partition", name: "lang", type: "text" },
          { kind: "metadata", name: "year", type: "integer" },
          { kind: "auxiliary", name: "title", type: "text" },
        ],
        options: [{ name: "chunk_size", value: "64", known: true }],
      },
    });
    expect(byName.v_int8).toMatchObject({
      rowCount: 2,
      createVersion: "v0.1.9",
      declaration: {
        columns: [
          { kind: "primary-key", name: "id", type: "integer" },
          { kind: "vector", name: "embedding", elementType: "int8", dims: 16, distanceMetric: null, extra: [] },
          { kind: "metadata", name: "cat", type: "text" },
        ],
        options: [],
      },
    });
    expect(byName.v_bit).toMatchObject({
      rowCount: 1,
      declaration: {
        columns: [
          { kind: "primary-key", name: "doc_id", type: "text" },
          { kind: "vector", name: "embedding", elementType: "bit", dims: 64, distanceMetric: null, extra: [] },
          { kind: "auxiliary", name: "note", type: "text" },
        ],
      },
    });
    // 섀도 테이블은 모두 <t>_ 접두
    for (const t of report.tables) for (const s of t.shadowTables) expect(s.startsWith(`${t.name}_`)).toBe(true);
  });

  it("prints a human table with dimensions, distance and column kinds", async () => {
    const db = join(tempDir(), "three.db");
    makeThreeTables(db);
    const r = await cli(["inspect", db]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("v_float  (3 rows, created with v0.1.9)");
    expect(r.stdout).toContain("embedding  float[8]  distance=cosine");
    expect(r.stdout).toContain("embedding  int8[16]  distance=l2 (default)");
    expect(r.stdout).toContain("embedding  bit[64]  distance=hamming (default)");
    expect(r.stdout).toContain("chunk_size=64");
    expect(r.stdout).toMatch(/partition key\s+lang text/);
  });

  it("round-trips declarations: format(parse(sql)) is accepted by sqlite-vec and parses to the same structure", () => {
    const db = join(tempDir(), "three.db");
    makeThreeTables(db);
    withDb(db, (conn) => {
      const rows = conn.prepare("select name, sql from sqlite_master where sql like 'create virtual table%'").all() as { name: string; sql: string }[];
      expect(rows.length).toBe(3);
      for (const { name, sql } of rows) {
        const decl = parseVec0Declaration(sql);
        const again = formatVec0Declaration(decl, `${name}_copy`);
        conn.exec(again); // sqlite-vec 가 받아들이는지
        expect(parseVec0Declaration(again).columns).toEqual(decl.columns);
        expect(parseVec0Declaration(again).options).toEqual(decl.options);
      }
    });
  });

  it("keeps unknown options verbatim instead of dropping them", () => {
    const decl = parseVec0Declaration("CREATE VIRTUAL TABLE x USING vec0(embedding float[4] future_opt=1, chunk_size=8, newopt=abc)");
    expect(decl.columns[0]).toMatchObject({ kind: "vector", extra: ["future_opt=1"] });
    expect(decl.options).toEqual([
      { name: "chunk_size", value: "8", known: true },
      { name: "newopt", value: "abc", known: false },
    ]);
    expect(formatVec0Declaration(decl, "x")).toBe("CREATE VIRTUAL TABLE x USING vec0(embedding float[4] future_opt=1, chunk_size=8, newopt=abc)");
  });

  it("normalizes accepted aliases (FLOAT, f32, int, double, bool, INTEGER PRIMARY KEY)", () => {
    const decl = parseVec0Declaration(
      'create virtual table if not exists "my table" using vec0(id INTEGER PRIMARY KEY, embedding FLOAT [8] DISTANCE_METRIC=COSINE, a int, b double, c bool, p TEXT partition key)',
    );
    expect(decl.table).toBe("my table");
    expect(decl.columns).toEqual([
      { kind: "primary-key", name: "id", type: "integer" },
      { kind: "vector", name: "embedding", elementType: "float", dims: 8, distanceMetric: "cosine", extra: [] },
      { kind: "metadata", name: "a", type: "integer" },
      { kind: "metadata", name: "b", type: "float" },
      { kind: "metadata", name: "c", type: "boolean" },
      { kind: "partition", name: "p", type: "text" },
    ]);
  });

  it.each([
    ["not vec0", "CREATE TABLE x(a, b)"],
    ["unknown vector type", "CREATE VIRTUAL TABLE x USING vec0(embedding vector[4])"],
    ["unknown metadata type", "CREATE VIRTUAL TABLE x USING vec0(embedding float[4], m real)"],
    ["bit with distance", "CREATE VIRTUAL TABLE x USING vec0(embedding bit[8] distance_metric=cosine)"],
    ["unknown metric", "CREATE VIRTUAL TABLE x USING vec0(embedding float[8] distance_metric=dot)"],
    ["no vector column", "CREATE VIRTUAL TABLE x USING vec0(a text)"],
    ["empty", "CREATE VIRTUAL TABLE x USING vec0()"],
    ["aux without type", "CREATE VIRTUAL TABLE x USING vec0(embedding float[4], +note)"],
    ["unknown constraint", "CREATE VIRTUAL TABLE x USING vec0(embedding float[4], a text unique)"],
    ["duplicate column", "CREATE VIRTUAL TABLE x USING vec0(embedding float[4], a text, a integer)"],
  ])("throws E_PARSE for %s (no guessing)", (_label, sql) => {
    let caught: unknown;
    try {
      parseVec0Declaration(sql);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Vec0KitError);
    expect((caught as Vec0KitError).code).toBe("E_PARSE");
  });

  it("reports a missing database file as a usage error (exit 2)", async () => {
    const r = await cli(["inspect", join(tempDir(), "nope.db")]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("E_NO_DB");
  });
});
