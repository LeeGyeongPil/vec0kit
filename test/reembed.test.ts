// AC-7: 재임베딩과 이어서 하기, OpenAI 호환 임베더(로컬 node:http 스텁)
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { createMockEmbedder } from "../src/embedders/mock.js";
import { createOpenAIEmbedder } from "../src/embedders/openai.js";
import type { Embedder } from "../src/embedders/types.js";
import { Vec0KitError } from "../src/errors.js";
import { migrate } from "../src/migrate.js";
import { type MigrationOptions, planMigration } from "../src/plan.js";
import { cli, countRows, declarationOf, makeCorpusDb, masterNames, tempDir, withDb } from "./helpers/fixtures.js";

/** 임베더 호출을 세는 래퍼 */
function counting(inner: Embedder): Embedder & { texts: number; calls: number } {
  const wrapper = {
    ...inner,
    texts: 0,
    calls: 0,
    async embed(texts: string[]) {
      wrapper.texts += texts.length;
      wrapper.calls++;
      return inner.embed(texts);
    },
  };
  return wrapper;
}

const OPTIONS = (embedder: Embedder): MigrationOptions => ({
  table: "vec_docs",
  to: "embedding float[128]",
  reembed: embedder.id!,
  source: { table: "docs", key: "id", text: "body" },
  batchSize: 50,
});

describe("AC-7 re-embed and resume", () => {
  it("resumes after a crash at batch 2 and embeds only the remaining rows", async () => {
    const path = join(tempDir(), "resume.db");
    makeCorpusDb(path, { dims: 64, rows: 200 });

    // 1) 첫 실행: 배치 2 가 커밋된 뒤 강제로 실패(프로세스가 죽은 것과 같은 상태)
    const first = counting(createMockEmbedder({ dims: 128 }));
    let db = openDatabase(path);
    try {
      const plan = planMigration(db, OPTIONS(first));
      expect(plan.mode).toBe("reembed");
      expect(plan.batches).toBe(4);
      await expect(
        migrate(db, plan, {
          embedder: first,
          onProgress: (p) => {
            if (p.phase === "embed" && p.batch === 2) throw new Error("simulated crash after batch 2");
          },
        }),
      ).rejects.toThrow("simulated crash");
    } finally {
      db.close();
    }
    expect(first.texts).toBe(100);
    expect(countRows(path, "vec_docs__vec0kit_new")).toBe(100); // 커밋된 두 배치
    expect(countRows(path, "vec_docs")).toBe(200); // 원본은 그대로
    expect(declarationOf(path, "vec_docs")).toContain("float[64]");

    // 2) 다른 옵션(차원 96)으로 다시 실행하면 거부
    db = openDatabase(path);
    try {
      let caught: unknown;
      try {
        planMigration(db, { ...OPTIONS(createMockEmbedder({ dims: 96 })), to: "embedding float[96]" });
      } catch (err) {
        caught = err;
      }
      expect((caught as Vec0KitError).code).toBe("E_RESUME_MISMATCH");
    } finally {
      db.close();
    }

    // 3) 같은 옵션으로 다시 실행: 남은 100행만 임베딩하고 끝까지
    const second = counting(createMockEmbedder({ dims: 128 }));
    db = openDatabase(path);
    try {
      const plan = planMigration(db, OPTIONS(second));
      expect(plan.resume).toMatchObject({ done: 100, phase: "filling" });
      const result = await migrate(db, plan, { embedder: second });
      expect(result.resumed).toBe(true);
      expect(result.resumedFrom).toBe(100);
      expect(result.embedded).toBe(100);
      expect(result.rowsAfter).toBe(200);
      expect(result.verify.passed).toBe(true);
    } finally {
      db.close();
    }
    expect(second.texts).toBe(200 - 100); // 재실행 임베딩 텍스트 수 = 전체 − 이미 처리분
    expect(countRows(path, "vec_docs")).toBe(200); // 최종 행 수 = 본문 행 수
    expect(declarationOf(path, "vec_docs")).toBe("CREATE VIRTUAL TABLE vec_docs USING vec0(embedding float[128], topic text, +title text)");
    expect(masterNames(path).filter((n) => n.includes("vec0kit"))).toEqual([]);
  });

  it("the CLI rejects a different plan while one is in progress (exit 2) and resumes the same one", async () => {
    const path = join(tempDir(), "cli-resume.db");
    makeCorpusDb(path, { dims: 64, rows: 120 });
    const db = openDatabase(path);
    try {
      const e = createMockEmbedder({ dims: 128 });
      const plan = planMigration(db, OPTIONS(e));
      await expect(migrate(db, plan, { embedder: e, onProgress: (p) => { if (p.batch === 1 && p.phase === "embed") throw new Error("stop"); } })).rejects.toThrow("stop");
    } finally {
      db.close();
    }
    const other = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[96]", "--reembed", "mock", "--source", "docs:id:body", "--no-backup"]);
    expect(other.code).toBe(2);
    expect(other.stderr).toContain("E_RESUME_MISMATCH");
    const same = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[128]", "--reembed", "mock", "--source", "docs:id:body", "--batch-size", "50", "--no-backup"]);
    expect(same.code).toBe(0);
    expect(same.stderr).toContain("Resuming: 50/120 already done");
    expect(countRows(path, "vec_docs")).toBe(120);
  });

  it("an empty document embeds to a zero vector: fail stops mid-run, rerunning with --on-invalid skip continues", async () => {
    const path = join(tempDir(), "empty-doc.db");
    makeCorpusDb(path, { dims: 64, rows: 120, metric: "cosine" });
    withDb(path, (db) => db.prepare("update docs set body = '' where id = 90").run()); // 빈 문서 → 목 임베더가 0 벡터를 낸다
    const args = ["migrate", path, "--table", "vec_docs", "--to", "embedding float[128] distance_metric=cosine", "--reembed", "mock", "--source", "docs:id:body", "--batch-size", "50", "--no-backup"];
    const first = await cli(args);
    expect(first.code).toBe(1);
    expect(first.stderr).toContain("E_INVALID_VECTORS");
    expect(first.stderr).toContain("key 90");
    expect(countRows(path, "vec_docs__vec0kit_new")).toBe(50); // 배치 1 은 저장됨, 배치 2 에서 멈춤
    expect(declarationOf(path, "vec_docs")).toContain("float[64]");

    const second = await cli([...args, "--on-invalid", "skip", "--json"]);
    expect(second.code).toBe(0);
    const { result } = JSON.parse(second.stdout);
    expect(result.resumedFrom).toBe(50);
    expect(result.skipped).toEqual([{ rule: "zero-vector", count: 1, sample: [90] }]);
    expect(result.rowsAfter).toBe(119);
  });

  it("changing dimensions without --reembed is refused", async () => {
    const path = join(tempDir(), "dims.db");
    makeCorpusDb(path, { dims: 64, rows: 10 });
    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[128]", "--no-backup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("needs new embeddings");
  });
});

describe("AC-7 OpenAI-compatible embedder against a local stub", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { body: { model: string; input: string[] }; auth: string | undefined; url: string }[] = [];
  let dims = 4;

  /** 결정적 가짜 임베딩: 글자 수와 첫 글자 코드로 벡터를 만든다 */
  const fake = (text: string) => Array.from({ length: dims }, (_, i) => ((text.length + i) % 7) / 7 + (text.charCodeAt(0) % 3) / 10 + 0.01);

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw) as { model: string; input: string[] };
        requests.push({ body, auth: req.headers.authorization, url: req.url ?? "" });
        // 일부러 거꾸로 보낸다 — 클라이언트가 index 로 다시 정렬해야 한다
        const data = body.input.map((t, index) => ({ object: "embedding", index, embedding: fake(t) })).reverse();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data, model: body.model }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends {model, input} and returns embeddings in index order", async () => {
    dims = 4;
    requests.length = 0;
    const e = createOpenAIEmbedder({ baseUrl, model: "stub-model", apiKey: "test-key", dims: 4 });
    const out = await e.embed(["a", "bb", "ccc"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("/v1/embeddings");
    expect(requests[0]!.body).toEqual({ model: "stub-model", input: ["a", "bb", "ccc"] });
    expect(requests[0]!.auth).toBe("Bearer test-key");
    expect(out.map((v) => Array.from(v))).toEqual(["a", "bb", "ccc"].map((t) => Array.from(new Float32Array(fake(t)))));
  });

  it("throws E_EMBED when the endpoint returns a different number of dimensions", async () => {
    dims = 3;
    const e = createOpenAIEmbedder({ baseUrl, model: "stub-model", dims: 4 });
    await expect(e.embed(["x"])).rejects.toMatchObject({ code: "E_EMBED" });
  });

  it("drives a full CLI migration with --reembed openai (env-configured, no API key)", async () => {
    dims = 16;
    requests.length = 0;
    const path = join(tempDir(), "openai.db");
    makeCorpusDb(path, { dims: 64, rows: 30 });
    const r = await cli(
      ["migrate", path, "--table", "vec_docs", "--to", "embedding float[16]", "--reembed", "openai", "--source", "docs:id:body", "--batch-size", "10", "--no-backup", "--json"],
      { VEC0KIT_EMBED_URL: baseUrl, VEC0KIT_EMBED_MODEL: "stub-model" },
    );
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests.every((q) => q.auth === undefined)).toBe(true);
    expect(JSON.parse(r.stdout).result.rowsAfter).toBe(30);
    expect(declarationOf(path, "vec_docs")).toContain("embedding float[16]");
  });

  it("--reembed openai without VEC0KIT_EMBED_URL / MODEL is a usage error", async () => {
    const path = join(tempDir(), "noenv.db");
    makeCorpusDb(path, { dims: 64, rows: 5 });
    const r = await cli(["migrate", path, "--table", "vec_docs", "--to", "embedding float[16]", "--reembed", "openai", "--source", "docs:id:body", "--no-backup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("VEC0KIT_EMBED_URL");
  });
});
