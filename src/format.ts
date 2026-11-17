// 출력 형식: 사람용(번역) 텍스트와 기계용 JSON.
// JSON 은 규칙 ID·메시지 키만 담아 언어와 상관없이 같다. BigInt 는 안전 범위면 숫자, 넘으면 문자열.
import type { CheckReport, Finding } from "./check.js";
import { toJsonSafe } from "./db.js";
import { type Vec0Column, effectiveMetric, parseReasonKey } from "./declaration.js";
import { Vec0KitError } from "./errors.js";
import { type Translate, hasMessage } from "./i18n/index.js";
import type { InspectReport, Vec0TableInfo } from "./inspect.js";
import type { MigrationResult } from "./migrate.js";
import type { MigrationPlan } from "./plan.js";
import type { VerifyReport } from "./verify.js";

export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => toJsonSafe(v), 2);
}

export function formatKeys(keys: readonly (bigint | string)[]): string {
  return keys.map((k) => String(k)).join(", ");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 터미널에서 차지하는 칸 수: 한글·한자 같은 전각 문자는 2칸 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60);
    w += wide ? 2 : 1;
  }
  return w;
}

function padDisplay(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

/** "label   value" 줄을 같은 폭으로 맞춘다 */
function rows(pairs: [string, string][], indent = "  "): string[] {
  const width = Math.max(...pairs.map(([l]) => displayWidth(l)));
  return pairs.map(([l, v]) => `${indent}${padDisplay(l, width)}  ${v}`);
}

/** 여러 줄 CREATE 문을 한 줄로 */
function oneLine(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

// ---------- inspect ----------

function describeColumn(c: Vec0Column, t: Translate): [string, string] {
  switch (c.kind) {
    case "vector": {
      const metric = c.distanceMetric ? t("inspect.distance", { metric: c.distanceMetric }) : t("inspect.distanceDefault", { metric: effectiveMetric(c) });
      return [t("inspect.vector"), [`${c.name}  ${c.elementType}[${c.dims}]  ${metric}`, ...c.extra].join("  ")];
    }
    case "primary-key":
      return [t("inspect.key"), `${c.name} ${c.type} primary key`];
    case "partition":
      return [t("inspect.partition"), `${c.name} ${c.type}`];
    case "metadata":
      return [t("inspect.metadata"), `${c.name} ${c.type}`];
    case "auxiliary":
      return [t("inspect.auxiliary"), `${c.name} ${c.type}`];
  }
}

export function formatTableInfo(info: Vec0TableInfo, t: Translate): string[] {
  const out = [t("inspect.table", { name: info.name, rows: info.rowCount, version: info.createVersion ?? t("inspect.unknownVersion") })];
  if (!info.declaration) {
    out.push(`  ${t("inspect.parseError", { detail: translateParseDetail(info.parseError ?? "", t) })}`);
    return out;
  }
  const pairs: [string, string][] = [];
  if (!info.declaration.columns.some((c) => c.kind === "primary-key")) pairs.push([t("inspect.key"), "rowid"]);
  for (const c of info.declaration.columns) pairs.push(describeColumn(c, t));
  if (info.declaration.options.length > 0) pairs.push([t("inspect.options"), info.declaration.options.map((o) => `${o.name}=${o.value}`).join(", ")]);
  pairs.push([t("inspect.shadow"), String(info.shadowTables.length)]);
  out.push(...rows(pairs));
  return out;
}

export function formatInspect(report: InspectReport, t: Translate): string {
  const out = [t("inspect.header", { vec: report.sqliteVecVersion, sqlite: report.sqliteVersion }), ""];
  if (report.tables.length === 0) out.push(t("inspect.none"));
  for (const info of report.tables) out.push(...formatTableInfo(info, t), "");
  return out.join("\n").trimEnd();
}

// ---------- check ----------

function formatFinding(f: Finding, t: Translate): string[] {
  const sev = padDisplay(t(`severity.${f.severity}`), 5);
  const where = [f.table, f.column].filter(Boolean).join(".");
  const head = [sev, f.rule.padEnd(16), where, f.count > 0 && f.rule !== "untested-version" && f.rule !== "version-skew" ? t("check.rows", { count: f.count }) : ""]
    .filter((x) => x !== "")
    .join("  ");
  const out = [head];
  const pad = " ".repeat(7);
  if (f.sample.length > 0) out.push(`${pad}${t("check.sample", { keys: formatKeys(f.sample) })}`);
  out.push(`${pad}${t(f.messageKey, f.params)}`);
  out.push(`${pad}${t("check.fix", { fix: t(f.fixKey, f.params) })}`);
  return out;
}

export function formatCheck(report: CheckReport, exitCode: number, t: Translate): string {
  const out = [t("check.header", { tables: report.tables.join(", ") || "-", rows: report.summary.rowsScanned }), ""];
  if (report.findings.length === 0) out.push(t("check.none"));
  for (const f of report.findings) out.push(...formatFinding(f, t), "");
  out.push(t("check.summary", { ...report.summary, code: exitCode }));
  return out.join("\n");
}

// ---------- migrate ----------

export function describeMode(plan: MigrationPlan, t: Translate): string {
  if (plan.mode === "quantize") {
    const v = plan.after.columns.find((c) => c.name === plan.vectorColumn);
    return t("mode.quantize", { type: v && v.kind === "vector" ? v.elementType : "?" });
  }
  if (plan.mode === "reembed") return t("mode.reembed", { source: plan.source?.table ?? "?", text: plan.source?.text ?? "?" });
  return t("mode.copy");
}

export function formatPlan(plan: MigrationPlan, t: Translate, opts: { dryRun: boolean; backupPath: string | null; mock: boolean }): string {
  const out = [t(opts.dryRun ? "plan.title.dryRun" : "plan.title.run")];
  const pairs: [string, string][] = [
    [t("plan.table"), plan.table],
    [t("plan.mode"), describeMode(plan, t) + (opts.mock ? `  [${t("mock.notice")}]` : "")],
    [t("plan.before"), oneLine(plan.beforeSql)],
    [t("plan.after"), plan.afterSql],
    [t("plan.rows"), t("plan.rowsValue", { process: plan.rowsToProcess, current: plan.rowCount, table: plan.table })],
    [t("plan.batches"), t("plan.batchesValue", { batches: plan.batches, size: plan.mode === "reembed" ? plan.batchSize : plan.rowsToProcess })],
    [t("plan.backup"), opts.backupPath ?? t("plan.noBackup")],
    [t("plan.extraDisk"), t("plan.extraDiskValue", { size: formatBytes(plan.estimatedExtraBytes) })],
    [
      t("plan.recall"),
      plan.minRecall !== null && plan.mode !== "reembed"
        ? t("plan.recallValue", { k: plan.k, min: plan.minRecall, sample: plan.sample })
        : t("plan.recallNone", { k: plan.k, sample: plan.sample }),
    ],
  ];
  if (plan.resume) pairs.push([t("plan.resume"), t("plan.resumeValue", { done: plan.resume.done, total: plan.rowsToProcess })]);
  if (plan.invalid.length > 0) {
    const items = plan.invalid.map((f) => t("plan.invalidItem", { rule: f.rule, count: f.count, keys: formatKeys(f.keys.slice(0, 10)) })).join("; ");
    pairs.push([t("plan.invalid"), `${items} — ${t(plan.onInvalid === "skip" ? "plan.invalidSkip" : "plan.invalidStop")}`]);
  }
  out.push(...rows(pairs));
  if (plan.notes.length > 0) {
    out.push(`  ${t("plan.notes")}:`);
    for (const n of plan.notes) out.push(`   - ${t(n.key, n.params)}`);
  }
  return out.join("\n");
}

/** --json 용 계획: 잘못된 벡터 키는 표본 10개만 */
export function planToJson(plan: MigrationPlan): unknown {
  return { ...plan, invalid: plan.invalid.map((f) => ({ rule: f.rule, count: f.count, sample: f.keys.slice(0, 10) })) };
}

export function formatVerify(v: VerifyReport, t: Translate): string {
  const mark = (ok: boolean) => t(ok ? "verify.ok" : "verify.fail");
  const parts = [
    t("verify.rowCount", { actual: v.rowCount.actual, expected: v.rowCount.expected, mark: mark(v.rowCount.ok) }),
    t("verify.keys", { mark: mark(v.keys.ok) }),
    t("verify.values", { mark: mark(v.values.ok), checked: v.values.checked }),
    `${t("verify.recall", { k: v.recall.k, value: v.recall.value === null ? "-" : v.recall.value.toFixed(3), queries: v.recall.queries })} ${
      v.recall.gated ? t("verify.recallGate", { min: v.recall.min ?? 0, mark: mark(v.recall.ok) }) : t(v.recall.neighbourAgreement ? "verify.recallInfo" : "verify.recallNoGate")
    }`,
  ];
  return parts.join(" · ");
}

export function formatResult(r: MigrationResult, t: Translate): string {
  const out = [t("result.title", { table: r.table, mode: r.mode })];
  const pairs: [string, string][] = [[t("result.rows"), t("result.rowsValue", { before: r.rowsBefore, after: r.rowsAfter })]];
  if (r.mode === "reembed") pairs.push([t("result.embedded"), t("result.embeddedValue", { count: r.embedded })]);
  if (r.skipped.length > 0) {
    pairs.push([t("result.skipped"), r.skipped.map((s) => t("result.skippedItem", { rule: s.rule, count: s.count, keys: formatKeys(s.sample) })).join("; ")]);
  }
  if (r.orphansDropped > 0) pairs.push([t("result.orphans"), String(r.orphansDropped)]);
  pairs.push([t("result.verify"), formatVerify(r.verify, t)]);
  pairs.push([t("result.backup"), r.backupPath ?? t("plan.noBackup")]);
  pairs.push([t("result.after"), r.afterSql]);
  out.push(...rows(pairs));
  return out.join("\n");
}

// ---------- 오류 ----------

/** Vec0KitError → 번역된 한 줄(+필요하면 자세한 줄) */
/** Translate a declaration parse failure detail (falls back to the raw text when unknown). */
export function translateParseDetail(detail: string, t: Translate): string {
  const key = parseReasonKey(detail);
  return key && hasMessage(`parse.${key.slug}`) ? t(`parse.${key.slug}`, key.params) : detail;
}

export function formatError(err: Vec0KitError, t: Translate): string {
  const reason = typeof err.params.reason === "string" ? `reason.${err.params.reason}` : null;
  const params = err.code === "E_PARSE" && typeof err.params.detail === "string" ? { ...err.params, detail: translateParseDetail(err.params.detail, t) } : err.params;
  const main = reason && hasMessage(reason) ? t(reason, params) : t(`error.${err.code}`, { detail: err.message, ...params });
  const out = [`${t("error.prefix")} [${err.code}]: ${main}`];
  if (err.code === "E_INVALID_VECTORS" && Array.isArray(err.details)) {
    for (const d of err.details as { rule: string; count: number; sample: (bigint | string)[] }[]) {
      out.push(`  ${t("error.invalidSample", { rule: d.rule, count: d.count, keys: formatKeys(d.sample) })}`);
    }
  }
  if (err.code === "E_VERIFY" && err.details && typeof err.details === "object" && "rowCount" in err.details) {
    out.push(`  ${t("verify.title")}: ${formatVerify(err.details as VerifyReport, t)}`);
    out.push(`  ${t("verify.hint")}`);
  }
  return out.join("\n");
}

export function errorToJson(err: Vec0KitError): unknown {
  return { error: { code: err.code, reason: err.params.reason ?? null, params: err.params, details: err.details ?? null } };
}
