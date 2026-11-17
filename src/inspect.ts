// inspect: DB 안의 vec0 테이블을 모두 찾아 선언·행 수·생성 버전을 모은다(읽기만 한다).
import { type Database, getVersions, quoteIdent, tableExists } from "./db.js";
import { type Vec0Declaration, parseVec0Declaration } from "./declaration.js";
import { Vec0KitError } from "./errors.js";

export interface Vec0TableInfo {
  name: string;
  sql: string;
  /** 파싱에 실패하면 null 이고 parseError 에 이유가 들어간다(추측하지 않는다) */
  declaration: Vec0Declaration | null;
  parseError: string | null;
  rowCount: number;
  /** <t>_info 섀도 테이블의 CREATE_VERSION (이 테이블을 만든 sqlite-vec 버전) */
  createVersion: string | null;
  /** <t>_ 로 시작하는 섀도 테이블 이름 */
  shadowTables: string[];
}

export interface InspectReport {
  sqliteVecVersion: string;
  sqliteVersion: string;
  tables: Vec0TableInfo[];
}

interface MasterRow {
  name: string;
  sql: string;
}

/** sqlite_master 에서 vec0 가상 테이블 목록(이름·원문 선언) */
export function listVec0Tables(db: Database): MasterRow[] {
  const rows = db
    .prepare("select name, sql from sqlite_master where type = 'table' and sql like 'create virtual table%' order by name")
    .all() as MasterRow[];
  return rows.filter((r) => /\busing\s+vec0\s*\(/i.test(r.sql));
}

export function inspectTable(db: Database, name: string): Vec0TableInfo {
  const row = listVec0Tables(db).find((r) => r.name === name);
  if (!row) throw new Vec0KitError("E_NO_TABLE", `no vec0 table named ${name}`, { table: name });
  let declaration: Vec0Declaration | null = null;
  let parseError: string | null = null;
  try {
    declaration = parseVec0Declaration(row.sql);
  } catch (err) {
    parseError = (err as Error).message;
  }
  const count = db.prepare(`select count(*) as c from ${quoteIdent(name)}`).get() as { c: bigint };
  let createVersion: string | null = null;
  if (tableExists(db, `${name}_info`)) {
    const info = db.prepare(`select value from ${quoteIdent(`${name}_info`)} where key = 'CREATE_VERSION'`).get() as
      | { value: string }
      | undefined;
    createVersion = info ? String(info.value) : null;
  }
  // 섀도 테이블: <t>_info, <t>_chunks, <t>_rowids, <t>_vector_chunksNN, <t>_metadata..., <t>_auxiliary
  const shadowPattern = new RegExp(`^${escapeRegExp(name)}_(info|chunks|rowids|vector_chunks\\d+|metadatachunks\\d+|metadatatext\\d+|auxiliary)$`);
  const shadowTables = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => shadowPattern.test(n));
  return { name, sql: row.sql, declaration, parseError, rowCount: Number(count.c), createVersion, shadowTables };
}

export function inspect(db: Database, opts: { table?: string } = {}): InspectReport {
  const versions = getVersions(db);
  const names = opts.table ? [opts.table] : listVec0Tables(db).map((r) => r.name);
  return { ...versions, tables: names.map((n) => inspectTable(db, n)) };
}

/** 선언을 꼭 읽어야 하는 곳(check·migrate)에서 쓴다: 파싱 실패면 E_PARSE 를 그대로 던진다. */
export function requireDeclaration(db: Database, name: string): { info: Vec0TableInfo; decl: Vec0Declaration } {
  const info = inspectTable(db, name);
  if (!info.declaration) throw parseVec0DeclarationError(info);
  return { info, decl: info.declaration };
}

function parseVec0DeclarationError(info: Vec0TableInfo): Vec0KitError {
  return new Vec0KitError("E_PARSE", info.parseError ?? `cannot parse ${info.name}`, { table: info.name, detail: info.parseError ?? "" });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
