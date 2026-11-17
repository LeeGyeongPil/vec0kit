// demo: 문제를 일부러 심은 demo.db 를 만들고 inspect → check → migrate --dry-run 을 차례로 보여 준다.
// 연습용 목(mock) 임베더(feature hashing)를 쓰므로 네트워크·키가 필요 없다.
import { existsSync, rmSync } from "node:fs";
import { openDatabase, tableExists } from "./db.js";
import { demoDocuments } from "./demo-corpus.js";
import { mockEmbed } from "./embedders/mock.js";
import { Vec0KitError } from "./errors.js";
import { toBlob } from "./vectors.js";

export const DEMO_MARKER_TABLE = "_vec0kit_demo";
export const DEMO_DIMS = 64;

/** 심어 둔 문제(테스트와 README 가 같은 값을 쓴다) */
export const DEMO_PLANTED = {
  emptyDocId: 1, // 본문이 빈 문서 → 0 벡터. 맨 먼저 넣어 cosine KNN 결과 맨 앞에 오는 현상이 보인다
  nanDocId: 77, // NaN 이 섞인 벡터
  missingDocId: 200, // 벡터가 없는 문서
  orphanIds: [501, 502], // 문서가 없는 벡터
} as const;

/** demo.db 가 이 도구가 만든 것인지(표식 테이블) — 아니면 덮어쓰지 않는다 */
function isOurDemo(path: string): boolean {
  try {
    const db = openDatabase(path, { readonly: true });
    try {
      return tableExists(db, DEMO_MARKER_TABLE);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function createDemoDatabase(path: string): void {
  if (existsSync(path)) {
    if (!isOurDemo(path)) throw new Vec0KitError("E_USAGE", `${path} exists and was not created by vec0kit demo`, { reason: "demo-exists", path });
    for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(path + suffix, { force: true });
  }
  const db = openDatabase(path, { create: true });
  try {
    const docs = demoDocuments(200);
    docs[DEMO_PLANTED.emptyDocId - 1]!.body = ""; // 빈 문서
    db.exec(`
      CREATE TABLE ${DEMO_MARKER_TABLE}(created_at TEXT NOT NULL);
      CREATE TABLE docs(id INTEGER PRIMARY KEY, topic TEXT NOT NULL, body TEXT NOT NULL);
      CREATE VIRTUAL TABLE vec_docs USING vec0(
        embedding float[${DEMO_DIMS}] distance_metric=cosine,
        topic text,
        +title text
      );`);
    const insertDoc = db.prepare("INSERT INTO docs(id, topic, body) VALUES (?, ?, ?)");
    const insertVec = db.prepare("INSERT INTO vec_docs(rowid, embedding, topic, title) VALUES (?, ?, ?, ?)");
    db.transaction(() => {
      db.prepare(`INSERT INTO ${DEMO_MARKER_TABLE}(created_at) VALUES (?)`).run(new Date().toISOString());
      for (const d of docs) {
        insertDoc.run(BigInt(d.id), d.topic, d.body);
        if (d.id === DEMO_PLANTED.missingDocId) continue; // 누락: 벡터를 넣지 않는다
        const v = mockEmbed(d.body, DEMO_DIMS); // 빈 본문 → 0 벡터
        if (d.id === DEMO_PLANTED.nanDocId) v[3] = Number.NaN; // NaN 심기(sqlite-vec 는 받아들인다)
        // rowid·INTEGER 는 BigInt 로 넣는다(number 는 REAL 로 바인딩되어 거부됨)
        insertVec.run(BigInt(d.id), toBlob(v), d.topic, d.body.split(" ").slice(0, 3).join(" ") || "(empty)");
      }
      for (const id of DEMO_PLANTED.orphanIds) {
        // 고아: 문서 없이 벡터만 있다(문서를 지우고 벡터를 안 지운 경우)
        insertVec.run(BigInt(id), toBlob(mockEmbed(`deleted document ${id}`, DEMO_DIMS)), "search", "deleted document");
      }
    })();
  } finally {
    db.close();
  }
}

/** 데모에서 차례로 보여 줄 명령(사람이 그대로 따라 칠 수 있는 형태) */
export function demoSteps(db: string): string[][] {
  return [
    ["inspect", db],
    ["check", db, "--table", "vec_docs", "--source", "docs:id", "--expect-dim", String(DEMO_DIMS)],
    [
      "migrate", db, "--table", "vec_docs",
      "--to", "embedding float[128] distance_metric=cosine",
      "--reembed", "mock", "--source", "docs:id:body", "--batch-size", "50", "--on-invalid", "skip", "--dry-run",
    ],
  ];
}

export function demoNextSteps(db: string): { key: string; args: string[] }[] {
  return [
    { key: "demo.nextMigrate", args: demoSteps(db)[2]!.filter((a) => a !== "--dry-run") },
    { key: "demo.nextQuantize", args: ["migrate", db, "--table", "vec_docs", "--quantize", "bit", "--on-invalid", "skip", "--min-recall", "0.99"] },
    { key: "demo.nextAbort", args: ["migrate", db, "--table", "vec_docs", "--abort"] },
  ];
}

/** 셸에 그대로 붙여 넣을 수 있게 공백이 있는 인자만 따옴표로 감싼다 */
export function shellLine(args: string[]): string {
  return ["vec0kit", ...args.map((a) => (/[\s"'[\]]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a))].join(" ");
}
