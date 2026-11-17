// AC-9 regression: no half-English errors under --lang ko, quiet EPIPE, --to typos are usage errors
import { writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exitQuietlyOnEpipe } from "../src/cli.js";
import { parseColumnDefinition, parseUserColumn } from "../src/declaration.js";
import { Vec0KitError } from "../src/errors.js";
import { formatError, translateParseDetail } from "../src/format.js";
import { MESSAGES, createTranslator } from "../src/i18n/index.js";
import { HANGUL, cli, makeCorpusDb, tempDir } from "./helpers/fixtures.js";

/** Lines of an error message that contain no Hangul at all (the part that would be English). */
const ENGLISH_WORDS = /\b(Unknown|argument|ambiguous|Did you forget|not a database|column has no type|please report)\b/i;

describe("parseArgs failures are translated", () => {
  it("unknown option", async () => {
    const dir = tempDir();
    const db = join(dir, "d.db");
    makeCorpusDb(db);
    const ko = await cli(["check", db, "--bogus", "--lang", "ko"]);
    expect(ko.code).toBe(2);
    expect(ko.stderr).toContain("E_USAGE");
    expect(ko.stderr).toContain("--bogus");
    expect(ko.stderr).toMatch(HANGUL);
    expect(ko.stderr).not.toMatch(ENGLISH_WORDS);
    const en = await cli(["check", db, "--bogus", "--lang", "en"]);
    expect(en.stderr).toContain("Unknown option --bogus");
  });

  it("missing and ambiguous option values", async () => {
    const dir = tempDir();
    const db = join(dir, "d.db");
    makeCorpusDb(db);
    for (const args of [["check", db, "--table"], ["check", db, "--table", "--strict"]]) {
      const ko = await cli(["--lang", "ko", ...args]);
      expect(ko.code).toBe(2);
      expect(ko.stderr).toContain("--table");
      expect(ko.stderr).toMatch(HANGUL);
      expect(ko.stderr).not.toMatch(ENGLISH_WORDS);
      const en = await cli(["--lang", "en", ...args]);
      expect(en.code).toBe(2);
      expect(en.stderr).not.toMatch(HANGUL);
    }
  });
});

describe("a file that is not a database", () => {
  it("is E_NOT_DB with a translated message and exit 2", async () => {
    const dir = tempDir();
    const junk = join(dir, "junk.db");
    writeFileSync(junk, "this is definitely not a sqlite file, just text. ".repeat(50));
    for (const cmd of ["check", "inspect"]) {
      const ko = await cli([cmd, junk, "--lang", "ko"]);
      expect(ko.code).toBe(2);
      expect(ko.stderr).toContain("E_NOT_DB");
      expect(ko.stderr).toMatch(HANGUL);
      expect(ko.stderr).not.toMatch(ENGLISH_WORDS);
      const en = await cli([cmd, junk, "--lang", "en"]);
      expect(en.stderr).toContain("E_NOT_DB");
      expect(en.stderr).toContain("not a SQLite database");
    }
  });
});

describe("declaration parse details are translated", () => {
  it("every parse failure message has a translation in both languages", () => {
    const samples = [
      "+title",
      "1bad int",
      "x",
      "x foo[0]",
      "x float[4] distance_metric=nope",
      "x bit[8] distance_metric=l2",
      "x float primary key",
      "x blob",
      "x text unique",
      "not sql",
      "create virtual table v using vec0(a float[4]",
      "create virtual table v using vec0()",
    ];
    const details = new Set<string>();
    for (const s of samples) {
      try {
        parseColumnDefinition(s);
      } catch (err) {
        if (err instanceof Vec0KitError) details.add(String(err.params.detail));
      }
    }
    expect(details.size).toBeGreaterThan(5);
    for (const d of details) {
      expect(translateParseDetail(d, createTranslator("ko")), d).toMatch(HANGUL);
      expect(translateParseDetail(d, createTranslator("en")), d).not.toMatch(HANGUL);
    }
    expect(translateParseDetail("duplicate column foo", createTranslator("ko"))).toContain("foo");
    for (const lang of ["en", "ko"] as const) {
      for (const slug of ["aux-no-type", "bad-name", "no-type", "bad-vector-type", "bad-metric", "bit-metric", "bad-pk", "bad-type", "bad-constraint", "not-vec0", "unbalanced", "empty", "empty-arg", "no-vector", "two-pks", "duplicate-column"]) {
        expect(MESSAGES[lang][`parse.${slug}`], `${lang} ${slug}`).toBeTruthy();
      }
    }
  });

  it("E_PARSE for a stored declaration is fully Korean under ko, but still says to report", () => {
    const err = new Vec0KitError("E_PARSE", "x", { detail: "column has no type" });
    const ko = formatError(err, createTranslator("ko"));
    expect(ko).toMatch(HANGUL);
    expect(ko).not.toContain("column has no type");
    expect(formatError(err, createTranslator("en"))).toContain("please report");
  });
});

describe("--to and --add-column typos are usage errors", () => {
  it("parseUserColumn throws E_USAGE, not E_PARSE", () => {
    expect(() => parseUserColumn("embedding", "--to")).toThrowError(expect.objectContaining({ code: "E_USAGE" }));
  });

  it("migrate --to embedding exits 2 and shows the expected form in both languages", async () => {
    const dir = tempDir();
    const db = join(dir, "d.db");
    makeCorpusDb(db);
    for (const to of ["embedding", "garbage[["]) {
      const en = await cli(["migrate", db, "--table", "vec_docs", "--to", to, "--dry-run", "--lang", "en"]);
      expect(en.code).toBe(2);
      expect(en.stderr).toContain("E_USAGE");
      expect(en.stderr).toContain("embedding float[768] distance_metric=cosine");
      expect(en.stderr).not.toContain("report");
      const ko = await cli(["migrate", db, "--table", "vec_docs", "--to", to, "--dry-run", "--lang", "ko"]);
      expect(ko.code).toBe(2);
      expect(ko.stderr).toMatch(HANGUL);
      expect(ko.stderr).toContain("embedding float[768] distance_metric=cosine");
    }
    const add = await cli(["migrate", db, "--table", "vec_docs", "--add-column", "lang", "--dry-run"]);
    expect(add.code).toBe(2);
  });

  it("--reembed with a bad --to is also a usage error", async () => {
    const dir = tempDir();
    const db = join(dir, "d.db");
    makeCorpusDb(db);
    const r = await cli(["migrate", db, "--table", "vec_docs", "--to", "embedding", "--reembed", "mock", "--source", "docs:id:body", "--dry-run", "--lang", "ko"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(HANGUL);
  });
});

describe("closed pipe (head, pager)", () => {
  it("exits 0 quietly on EPIPE and rethrows other stream errors", () => {
    const stream = new EventEmitter();
    const exits: number[] = [];
    exitQuietlyOnEpipe([stream as unknown as NodeJS.WritableStream], (c) => exits.push(c));
    stream.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(exits).toEqual([0]);
    expect(() => stream.emit("error", Object.assign(new Error("boom"), { code: "EIO" }))).toThrow("boom");
  });
});

describe("re-embed progress counts rows, not texts", () => {
  it("progress says rows processed and the summary explains skipped rows", async () => {
    const en = MESSAGES.en["progress.embed"]!;
    expect(en).toContain("rows");
    expect(MESSAGES.ko["progress.embed"]).toContain("행");
  });
});
