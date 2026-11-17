// vec0 선언문 파서·재조립기.
// sqlite_master 에 남아 있는 "CREATE VIRTUAL TABLE t USING vec0(...)" 원문을 읽어
// 벡터 열(타입·차원·거리), 기본 키, 파티션 키, 메타데이터 열, 보조(+) 열, 테이블 옵션을 구조로 바꾼다.
// 문법은 sqlite-vec 0.1.9 에서 프로브로 확인한 범위만 받아들이고, 모르면 추측하지 않고 E_PARSE 를 던진다.
import { Vec0KitError } from "./errors.js";

export type ElementType = "float" | "int8" | "bit";
export type DistanceMetric = "l2" | "cosine" | "l1" | "hamming";
export type MetadataType = "text" | "integer" | "float" | "boolean";

export interface VectorColumn {
  kind: "vector";
  name: string;
  elementType: ElementType;
  dims: number;
  /** 선언에 적힌 거리 함수. 적지 않았으면 null(기본값: float·int8 은 l2, bit 는 hamming) */
  distanceMetric: DistanceMetric | null;
  /** 이 도구가 모르는 열 옵션(원문 그대로 보존) */
  extra: string[];
}
export interface PrimaryKeyColumn {
  kind: "primary-key";
  name: string;
  type: "integer" | "text";
}
export interface PartitionColumn {
  kind: "partition";
  name: string;
  type: MetadataType;
}
export interface MetadataColumn {
  kind: "metadata";
  name: string;
  type: MetadataType;
}
export interface AuxiliaryColumn {
  kind: "auxiliary";
  name: string;
  type: string;
}
export type Vec0Column = VectorColumn | PrimaryKeyColumn | PartitionColumn | MetadataColumn | AuxiliaryColumn;

export interface TableOption {
  name: string;
  value: string;
  /** chunk_size 처럼 이 도구가 아는 옵션인지(모르는 옵션도 원문 그대로 다시 쓴다) */
  known: boolean;
}

export interface Vec0Declaration {
  table: string;
  /** 선언 순서 그대로 */
  columns: Vec0Column[];
  options: TableOption[];
}

/** sqlite-vec 0.1.9 문서·프로브의 한도 */
export const LIMITS = { metadata: 16, partition: 4, auxiliary: 16 } as const;

const KNOWN_OPTIONS = new Set(["chunk_size"]);
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 테이블 이름은 따옴표로 감쌀 수 있다("...", `...`, [...]).
const TABLE_IDENT = String.raw`"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*`;
const HEADER = new RegExp(
  String.raw`^\s*create\s+virtual\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:${TABLE_IDENT})\s*\.\s*)?(${TABLE_IDENT})\s+using\s+vec0\s*\(`,
  "i",
);

function parseError(message: string, sql: string): Vec0KitError {
  return new Vec0KitError("E_PARSE", `${message}: ${sql.trim().slice(0, 200)}`, { detail: message });
}

/** Stable translation keys (parse.<slug>) for every parse failure message; see formatError. */
const PARSE_SLUGS: Record<string, string> = {
  "auxiliary column needs a name and a type": "aux-no-type",
  "unsupported column name": "bad-name",
  "column has no type": "no-type",
  "unknown vector type": "bad-vector-type",
  "unknown distance_metric": "bad-metric",
  "bit vectors do not take distance_metric": "bit-metric",
  "primary key must be integer or text": "bad-pk",
  "unknown column type": "bad-type",
  "unknown column constraint": "bad-constraint",
  "not a CREATE VIRTUAL TABLE ... USING vec0(...) statement": "not-vec0",
  "unbalanced parentheses": "unbalanced",
  "empty vec0 declaration": "empty",
  "empty argument": "empty-arg",
  "no vector column": "no-vector",
  "more than one primary key": "two-pks",
};

/** Translation slug and params for a parse failure detail (null when unknown, so the raw text is kept). */
export function parseReasonKey(detail: string): { slug: string; params: Record<string, string> } | null {
  const slug = PARSE_SLUGS[detail];
  if (slug) return { slug, params: {} };
  const dup = /^duplicate column (.+)$/.exec(detail);
  if (dup) return { slug: "duplicate-column", params: { column: dup[1]! } };
  return null;
}

/**
 * Parse a column declaration the user typed on the command line (--to, --add-column).
 * A failure is a usage error (exit 2) that shows the expected form, not a "please report" parse error.
 */
export function parseUserColumn(arg: string, option: string): Vec0Column | TableOption {
  try {
    return parseColumnDefinition(arg);
  } catch (err) {
    if (err instanceof Vec0KitError && err.code === "E_PARSE") {
      throw new Vec0KitError("E_USAGE", `${option} "${arg}" is not a valid column declaration`, { reason: "bad-column-arg", option, value: arg });
    }
    throw err;
  }
}

function unquote(ident: string): string {
  if (ident.startsWith('"')) return ident.slice(1, -1).replaceAll('""', '"');
  if (ident.startsWith("`") || ident.startsWith("[")) return ident.slice(1, -1);
  return ident;
}

/** 괄호·따옴표 안의 쉼표는 무시하고 최상위 쉼표로만 나눈다. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim());
}

function normalizeMetadataType(raw: string): MetadataType | null {
  switch (raw.toLowerCase()) {
    case "text":
      return "text";
    case "integer":
    case "int":
      return "integer";
    case "float":
    case "double":
      return "float";
    case "boolean":
    case "bool":
      return "boolean";
    default:
      return null;
  }
}

function normalizeElementType(raw: string): ElementType | null {
  switch (raw.toLowerCase()) {
    case "float":
    case "float32":
    case "f32":
      return "float";
    case "int8":
    case "i8":
      return "int8";
    case "bit":
      return "bit";
    default:
      return null;
  }
}

/**
 * vec0(...) 괄호 안의 인자 하나(열 선언 또는 테이블 옵션)를 해석한다.
 * `--to "embedding float[768] distance_metric=cosine"`, `--add-column "lang text partition key"` 도 이 함수로 읽는다.
 */
export function parseColumnDefinition(arg: string): Vec0Column | TableOption {
  const text = arg.trim();
  // 1) 테이블 옵션: chunk_size=64 (이름 바로 뒤에 '=')
  const opt = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/.exec(text);
  if (opt) {
    const name = opt[1]!.toLowerCase();
    return { name, value: opt[2]!.trim(), known: KNOWN_OPTIONS.has(name) };
  }
  // 2) 보조 열: +title text (sqlite-vec 0.1.9 는 타입이 꼭 있어야 한다)
  const aux = /^\+\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z]+)$/.exec(text);
  if (aux) return { kind: "auxiliary", name: aux[1]!, type: aux[2]!.toLowerCase() };
  if (text.startsWith("+")) throw parseError("auxiliary column needs a name and a type", text);

  // 3) 나머지: "이름 타입 ..." — 'float [8]' 처럼 대괄호 앞 공백은 붙인다.
  const tokens = text.replace(/\s+\[/g, "[").split(/\s+/);
  const name = tokens[0] ?? "";
  if (!COLUMN_NAME.test(name)) throw parseError("unsupported column name", text);
  const typeToken = tokens[1];
  if (!typeToken) throw parseError("column has no type", text);

  // 3-a) 벡터 열: float[8] / int8[16] / bit[64]
  const vec = /^([A-Za-z0-9]+)\[(\d+)\]$/.exec(typeToken);
  if (vec) {
    const elementType = normalizeElementType(vec[1]!);
    const dims = Number(vec[2]);
    if (!elementType || !Number.isInteger(dims) || dims <= 0) throw parseError("unknown vector type", text);
    let distanceMetric: DistanceMetric | null = null;
    const extra: string[] = [];
    for (const token of tokens.slice(2)) {
      const kv = /^distance_metric=(\w+)$/i.exec(token);
      if (kv) {
        const metric = kv[1]!.toLowerCase();
        if (metric !== "l2" && metric !== "cosine" && metric !== "l1") throw parseError("unknown distance_metric", text);
        if (elementType === "bit") throw parseError("bit vectors do not take distance_metric", text);
        distanceMetric = metric;
      } else {
        extra.push(token); // 모르는 옵션은 원문 보존
      }
    }
    return { kind: "vector", name, elementType, dims, distanceMetric, extra };
  }

  const rest = tokens.slice(2).join(" ").toLowerCase();
  // 3-b) 기본 키: id integer primary key / doc_id text primary key
  if (rest === "primary key") {
    const t = typeToken.toLowerCase();
    if (t === "integer" || t === "int") return { kind: "primary-key", name, type: "integer" };
    if (t === "text") return { kind: "primary-key", name, type: "text" };
    throw parseError("primary key must be integer or text", text);
  }
  const type = normalizeMetadataType(typeToken);
  if (!type) throw parseError("unknown column type", text);
  // 3-c) 파티션 키
  if (rest === "partition key") return { kind: "partition", name, type };
  // 3-d) 메타데이터 열
  if (rest === "") return { kind: "metadata", name, type };
  throw parseError("unknown column constraint", text);
}

export function isTableOption(x: Vec0Column | TableOption): x is TableOption {
  return !("kind" in x);
}

/** CREATE VIRTUAL TABLE ... USING vec0(...) 전체를 해석한다. */
export function parseVec0Declaration(sql: string): Vec0Declaration {
  const header = HEADER.exec(sql);
  if (!header) throw parseError("not a CREATE VIRTUAL TABLE ... USING vec0(...) statement", sql);
  const table = unquote(header[1]!);
  const start = header[0].length;
  const end = sql.lastIndexOf(")");
  if (end < start || sql.slice(end + 1).replace(/;/g, "").trim() !== "") throw parseError("unbalanced parentheses", sql);
  const body = sql.slice(start, end);
  if (body.trim() === "") throw parseError("empty vec0 declaration", sql);

  const columns: Vec0Column[] = [];
  const options: TableOption[] = [];
  for (const arg of splitTopLevel(body)) {
    if (arg === "") throw parseError("empty argument", sql);
    const parsed = parseColumnDefinition(arg);
    if (isTableOption(parsed)) options.push(parsed);
    else columns.push(parsed);
  }
  const decl: Vec0Declaration = { table, columns, options };
  validateDeclaration(decl, sql);
  return decl;
}

function validateDeclaration(decl: Vec0Declaration, sql: string): void {
  if (vectorColumns(decl).length === 0) throw parseError("no vector column", sql);
  if (decl.columns.filter((c) => c.kind === "primary-key").length > 1) throw parseError("more than one primary key", sql);
  const seen = new Set<string>();
  for (const c of decl.columns) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) throw parseError(`duplicate column ${c.name}`, sql);
    seen.add(key);
  }
}

export function formatColumn(c: Vec0Column): string {
  switch (c.kind) {
    case "vector": {
      const parts = [`${c.name} ${c.elementType}[${c.dims}]`];
      if (c.distanceMetric) parts.push(`distance_metric=${c.distanceMetric}`);
      parts.push(...c.extra);
      return parts.join(" ");
    }
    case "primary-key":
      return `${c.name} ${c.type} primary key`;
    case "partition":
      return `${c.name} ${c.type} partition key`;
    case "metadata":
      return `${c.name} ${c.type}`;
    case "auxiliary":
      return `+${c.name} ${c.type}`;
  }
}

/** 구조 → CREATE VIRTUAL TABLE 문. 이름은 인자로 받아 임시 테이블에도 같은 선언을 쓸 수 있게 한다. */
export function formatVec0Declaration(decl: Vec0Declaration, name: string): string {
  const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
  const args = [...decl.columns.map(formatColumn), ...decl.options.map((o) => `${o.name}=${o.value}`)];
  return `CREATE VIRTUAL TABLE ${quoted} USING vec0(${args.join(", ")})`;
}

// ---- 조회 도우미 ----

export function vectorColumns(decl: Vec0Declaration): VectorColumn[] {
  return decl.columns.filter((c): c is VectorColumn => c.kind === "vector");
}

export function primaryKey(decl: Vec0Declaration): PrimaryKeyColumn | null {
  return decl.columns.find((c): c is PrimaryKeyColumn => c.kind === "primary-key") ?? null;
}

/** 행을 가리키는 열: 기본 키를 선언했으면 그 열, 아니면 rowid (선언된 PK 가 있으면 rowid 열은 없다 — 프로브 확인) */
export function keyColumn(decl: Vec0Declaration): string {
  return primaryKey(decl)?.name ?? "rowid";
}

export function effectiveMetric(v: VectorColumn): DistanceMetric {
  return v.distanceMetric ?? (v.elementType === "bit" ? "hamming" : "l2");
}

/** 벡터 하나가 차지하는 바이트 수 */
export function vectorBytes(v: VectorColumn): number {
  if (v.elementType === "float") return v.dims * 4;
  if (v.elementType === "int8") return v.dims;
  return Math.ceil(v.dims / 8);
}

export function countByKind(decl: Vec0Declaration): { metadata: number; partition: number; auxiliary: number } {
  return {
    metadata: decl.columns.filter((c) => c.kind === "metadata").length,
    partition: decl.columns.filter((c) => c.kind === "partition").length,
    auxiliary: decl.columns.filter((c) => c.kind === "auxiliary").length,
  };
}
