#!/usr/bin/env node
// vec0kit CLI: inspect · check · migrate · demo
// 종료 코드: 0 정상 · 1 문제 발견/검증 실패 · 2 사용법/계획 거부 · 3 실행 오류 · 130 Ctrl-C 로 멈춤(이어서 가능)
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check, exitCodeForReport } from "./check.js";
import { type Database, openDatabase } from "./db.js";
import { isTableOption, parseUserColumn, vectorColumns } from "./declaration.js";
import { createDemoDatabase, demoNextSteps, demoSteps, shellLine } from "./demo.js";
import { createMockEmbedder } from "./embedders/mock.js";
import { createOpenAIEmbedder } from "./embedders/openai.js";
import type { Embedder } from "./embedders/types.js";
import { Vec0KitError, exitCodeFor } from "./errors.js";
import { errorToJson, formatCheck, formatError, formatInspect, formatPlan, formatResult, planToJson, toJson } from "./format.js";
import { type Lang, type Translate, createTranslator, resolveLang } from "./i18n/index.js";
import { inspect, requireDeclaration } from "./inspect.js";
import { abortMigration, migrate } from "./migrate.js";
import { type MigrationOptions, parseSourceSpec, readState } from "./plan.js";
import { planMigration } from "./plan.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** 출력이 head·pager 로 닫히면(EPIPE) 조용히 끝낸다: 이행은 이어서 할 수 있고 데이터는 안전하다 */
export function exitQuietlyOnEpipe(streams: NodeJS.WritableStream[] = [process.stdout, process.stderr], exit: (code: number) => void = (c) => process.exit(c)): void {
  for (const stream of streams) {
    stream.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") exit(0);
      else throw err;
    });
  }
}

const defaultIO: CliIO = {
  stdout: (s) => process.stdout.write(`${s}\n`),
  stderr: (s) => process.stderr.write(`${s}\n`),
  env: process.env,
  cwd: process.cwd(),
};

const OPTIONS = {
  lang: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  table: { type: "string" },
  source: { type: "string" },
  column: { type: "string" },
  "expect-dim": { type: "string" },
  "expect-normalized": { type: "boolean" },
  strict: { type: "boolean" },
  to: { type: "string" },
  quantize: { type: "string" },
  "add-column": { type: "string", multiple: true },
  "drop-column": { type: "string", multiple: true },
  fill: { type: "string", multiple: true },
  reembed: { type: "string" },
  "batch-size": { type: "string" },
  "min-recall": { type: "string" },
  sample: { type: "string" },
  k: { type: "string" },
  "on-invalid": { type: "string" },
  backup: { type: "string" },
  "no-backup": { type: "boolean" },
  "dry-run": { type: "boolean" },
  resume: { type: "boolean" },
  abort: { type: "boolean" },
  db: { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

function usage(reason: string, params: Record<string, string | number> = {}): Vec0KitError {
  return new Vec0KitError("E_USAGE", `${reason} ${JSON.stringify(params)}`, { reason, ...params });
}

/** Turn a node:util parseArgs failure into a translatable usage error (no raw English library text). */
function argsError(err: unknown): Vec0KitError {
  const { code, message } = err as { code?: string; message?: string };
  // 메시지의 첫 따옴표 값이 옵션 이름이다: Unknown option '--bogus' / Option '--table <value>' argument is missing
  const quoted = /'(-[^']*)'/.exec(message ?? "")?.[1] ?? "";
  const option = quoted.split(/\s+/)[0] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return usage("unknown-option", { option });
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    return usage(/ambiguous/.test(message ?? "") ? "ambiguous-value" : "missing-value", { option });
  }
  return usage("bad-args-generic");
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/** parseArgs 보다 먼저 --lang 만 꺼낸다(인자 오류 메시지도 고른 언어로 보여 주려고) */
function peekLang(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--lang") return argv[i + 1];
    if (a.startsWith("--lang=")) return a.slice("--lang=".length);
  }
  return undefined;
}

function choice<T extends string>(option: string, value: string | undefined, choices: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (!(choices as readonly string[]).includes(value)) throw usage("bad-choice", { option, choices: choices.join("|"), value });
  return value as T;
}

function positiveInt(option: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw usage("bad-number", { option });
  return n;
}

/** 기본 백업 경로: <db>.vec0kit-YYYYMMDD-HHMMSS.bak — 같은 초에 이미 있으면 -2, -3 … 을 붙여 옛 백업을 덮어쓰지 않는다 */
export function defaultBackupPath(dbPath: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let candidate = `${dbPath}.vec0kit-${stamp}.bak`;
  for (let i = 2; existsSync(candidate); i++) candidate = `${dbPath}.vec0kit-${stamp}-${i}.bak`;
  return candidate;
}

export async function run(argv: string[], io: CliIO = defaultIO): Promise<number> {
  // 1) 언어 먼저: --lang > VEC0KIT_LANG > LC_ALL > LC_MESSAGES > LANG
  const cliLang = peekLang(argv);
  const lang: Lang = resolveLang(cliLang === "en" || cliLang === "ko" ? cliLang : undefined, io.env);
  const t = createTranslator(lang);
  const wantsJson = argv.includes("--json");
  const fail = (err: unknown): number => {
    if (err instanceof Vec0KitError) {
      if (wantsJson) io.stdout(toJson(errorToJson(err)));
      else io.stderr(formatError(err, t));
      return exitCodeFor(err.code);
    }
    const message = (err as Error)?.message ?? String(err);
    if (wantsJson) io.stdout(toJson({ error: { code: "E_RUNTIME", reason: null, params: { detail: message }, details: null } }));
    else io.stderr(`${t("error.prefix")}: ${message}`);
    return 3;
  };

  try {
    if (cliLang !== undefined && cliLang !== "en" && cliLang !== "ko") throw usage("bad-lang", { value: cliLang });
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
    } catch (err) {
      throw argsError(err);
    }
    const { values, positionals } = parsed;
    const [command, ...rest] = positionals;

    if (values.version) {
      io.stdout(packageVersion());
      return 0;
    }
    if (!command || command === "help") {
      io.stdout(t("help.main", { version: packageVersion() }));
      return 0;
    }
    if (!["inspect", "check", "migrate", "demo"].includes(command)) throw usage("unknown-command", { command });
    if (values.help) {
      io.stdout(t(`help.${command}`));
      return 0;
    }
    if (command === "demo") return await runDemo(values, io, t, cliLang, lang);

    const dbPath = rest[0];
    if (!dbPath) throw usage("missing-db", { command });
    if (command === "inspect") return runInspect(dbPath, values, io, t);
    if (command === "check") return runCheck(dbPath, values, io, t);
    return await runMigrate(dbPath, values, io, t);
  } catch (err) {
    return fail(err);
  }
}

// ---------------- inspect ----------------

function runInspect(dbPath: string, values: Values, io: CliIO, t: Translate): number {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const report = inspect(db, values.table ? { table: values.table } : {});
    io.stdout(values.json ? toJson(report) : formatInspect(report, t));
    return 0;
  } finally {
    db.close();
  }
}

// ---------------- check ----------------

function runCheck(dbPath: string, values: Values, io: CliIO, t: Translate): number {
  const expectDim = positiveInt("--expect-dim", values["expect-dim"]);
  const source = values.source ? parseSourceSpec(values.source) : undefined;
  const db = openDatabase(dbPath, { readonly: true });
  try {
    const report = check(db, {
      ...(values.table ? { table: values.table } : {}),
      ...(source ? { source: { table: source.table, key: source.key } } : {}),
      ...(expectDim !== undefined ? { expectDim } : {}),
      ...(values["expect-normalized"] ? { expectNormalized: true } : {}),
      ...(values.column ? { column: values.column } : {}),
    });
    const code = exitCodeForReport(report, values.strict ?? false);
    io.stdout(values.json ? toJson(report) : formatCheck(report, code, t));
    return code;
  } finally {
    db.close();
  }
}

// ---------------- migrate ----------------

/** 재임베딩 목표 차원: --to 에 적힌 차원, 없으면 지금 벡터 열 차원 */
function targetDims(db: Database, table: string, values: Values): number {
  if (values.to) {
    const parsed = parseUserColumn(values.to, "--to");
    if (!isTableOption(parsed) && parsed.kind === "vector") return parsed.dims;
  }
  const { decl } = requireDeclaration(db, table);
  const vectors = vectorColumns(decl);
  const v = values.column ? vectors.find((c) => c.name === values.column) : vectors.length === 1 ? vectors[0] : undefined;
  if (!v) throw usage("mock-dims");
  return v.dims;
}

function buildEmbedder(kind: "mock" | "openai", dims: number, env: NodeJS.ProcessEnv): Embedder {
  if (kind === "mock") return createMockEmbedder({ dims });
  const baseUrl = env.VEC0KIT_EMBED_URL;
  const model = env.VEC0KIT_EMBED_MODEL;
  if (!baseUrl || !model) throw usage("openai-config");
  return createOpenAIEmbedder({ baseUrl, model, dims, ...(env.VEC0KIT_EMBED_API_KEY ? { apiKey: env.VEC0KIT_EMBED_API_KEY } : {}) });
}

async function runMigrate(dbPath: string, values: Values, io: CliIO, t: Translate): Promise<number> {
  const table = values.table;
  if (!table) throw usage("missing-table");
  const json = values.json ?? false;

  // --abort: 끝나지 않은 이행만 지운다(원본은 건드리지 않는다)
  if (values.abort) {
    const db = openDatabase(dbPath);
    try {
      const { removed } = abortMigration(db, table);
      io.stdout(json ? toJson({ aborted: removed, table }) : t(removed ? "abort.removed" : "abort.nothing", { table }));
      return 0;
    } finally {
      db.close();
    }
  }

  const quantize = choice("--quantize", values.quantize, ["int8", "bit"] as const);
  const onInvalid = choice("--on-invalid", values["on-invalid"], ["fail", "skip"] as const);
  const reembed = choice("--reembed", values.reembed, ["mock", "openai"] as const);
  const fill: Record<string, string> = {};
  for (const f of values.fill ?? []) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(f);
    if (!m) throw usage("bad-fill", { value: f });
    fill[m[1]!] = m[2]!;
  }
  const minRecallRaw = values["min-recall"];
  const minRecall = minRecallRaw === undefined ? undefined : Number(minRecallRaw);
  if (minRecall !== undefined && !(minRecall >= 0 && minRecall <= 1)) throw usage("bad-recall");
  const hasChange = Boolean(values.to || quantize || reembed || values["add-column"]?.length || values["drop-column"]?.length);
  if (!hasChange) throw usage("no-change");

  const dryRun = values["dry-run"] ?? false;
  // dry-run 은 읽기 전용으로 연다 — 파일이 절대 바뀌지 않는다
  const db = openDatabase(dbPath, { readonly: dryRun });
  try {
    const embedder = reembed ? buildEmbedder(reembed, targetDims(db, table, values), io.env) : undefined;
    const opts: MigrationOptions = {
      table,
      ...(values.to ? { to: values.to } : {}),
      ...(values.column ? { column: values.column } : {}),
      ...(quantize ? { quantize } : {}),
      ...(values["add-column"] ? { addColumns: values["add-column"] } : {}),
      ...(values["drop-column"] ? { dropColumns: values["drop-column"] } : {}),
      ...(Object.keys(fill).length > 0 ? { fill } : {}),
      ...(embedder ? { reembed: embedder.id ?? reembed! } : {}),
      ...(values.source ? { source: parseSourceSpec(values.source) } : {}),
      ...(values["batch-size"] !== undefined ? { batchSize: positiveInt("--batch-size", values["batch-size"])! } : {}),
      ...(minRecall !== undefined ? { minRecall } : {}),
      ...(values.sample !== undefined ? { sample: positiveInt("--sample", values.sample)! } : {}),
      ...(values.k !== undefined ? { k: positiveInt("--k", values.k)! } : {}),
      ...(onInvalid ? { onInvalid } : {}),
    };
    const plan = planMigration(db, opts);
    if (values.resume && !plan.resume) throw usage("resume-nothing", { table });
    const backupPath = plan.resume ? plan.resume.backupPath : values["no-backup"] ? null : (values.backup ?? defaultBackupPath(dbPath));
    // 직접 준 백업 경로에 파일이 있으면 덮어쓰지 않는다(이전 백업을 잃지 않게)
    if (!plan.resume && values.backup && existsSync(values.backup)) throw usage("backup-exists", { path: values.backup });
    const mock = reembed === "mock";

    if (dryRun) {
      io.stdout(json ? toJson({ dryRun: true, mock, backupPath, plan: planToJson(plan) }) : `${formatPlan(plan, t, { dryRun: true, backupPath, mock })}\n\n${t("plan.applyHint")}`);
      return 0;
    }
    if (!json) io.stdout(formatPlan(plan, t, { dryRun: false, backupPath, mock }));
    if (!json && plan.resume) io.stderr(t("progress.resuming", { done: plan.resume.done, total: plan.rowsToProcess }));

    // Ctrl-C: 첫 번째는 "이 배치까지 저장하고 멈춤", 두 번째는 즉시 종료(커밋된 배치는 남는다)
    let stopRequested = false;
    const onSigint = () => {
      if (stopRequested) process.exit(130);
      stopRequested = true;
      io.stderr(t("progress.stopping"));
    };
    process.on("SIGINT", onSigint);
    try {
      const result = await migrate(db, plan, {
        ...(embedder ? { embedder } : {}),
        backupPath,
        onProgress: (p) => {
          if (!json) {
            if (p.phase === "embed") io.stderr(t("progress.embed", { done: p.done, total: p.total, batch: p.batch }));
            else if (p.phase === "backup") io.stderr(t("progress.backup", { path: backupPath ?? "" }));
            else if (p.phase === "copy" && p.done === 0) io.stderr(t("progress.copy", { total: p.total }));
            else if (p.phase === "verify") io.stderr(t("progress.verify"));
            else if (p.phase === "swap") io.stderr(t("progress.swap"));
          }
          if (stopRequested && p.phase === "embed") throw new Interrupted();
        },
      });
      io.stdout(json ? toJson({ dryRun: false, mock, plan: planToJson(plan), result }) : `\n${formatResult(result, t)}`);
      return 0;
    } catch (err) {
      if (err instanceof Interrupted) {
        const st = readState(db, table);
        io.stderr(t("progress.interrupted", { done: st?.done ?? 0, total: plan.rowsToProcess }));
        return 130;
      }
      throw err;
    } finally {
      process.off("SIGINT", onSigint);
    }
  } finally {
    db.close();
  }
}

class Interrupted extends Error {}

// ---------------- demo ----------------

async function runDemo(values: Values, io: CliIO, t: Translate, cliLang: string | undefined, lang: Lang): Promise<number> {
  const path = values.db ?? join(io.cwd, "demo.db");
  // 화면에 보일 경로: 기본값이면 짧게 demo.db
  const shown = values.db ?? basename(path);
  createDemoDatabase(path);
  io.stdout(t("demo.title"));
  io.stdout(t("demo.created", { path: shown }));
  const langArgs = cliLang ? ["--lang", cliLang] : [];
  // 작업 폴더가 같으면 짧은 경로 그대로 실행(출력의 백업 경로도 짧게 보인다)
  const sameCwd = io.cwd === process.cwd();
  for (const step of demoSteps(shown)) {
    io.stdout("");
    io.stdout(t("demo.step", { command: shellLine(step) }));
    const real = sameCwd ? step : step.map((a) => (a === shown ? path : a));
    const code = await run([...real, ...langArgs], io);
    if (step[0] === "check") io.stdout(t("demo.checkExit", { code }));
    else if (code !== 0) return code;
  }
  io.stdout("");
  io.stdout(t("demo.next"));
  for (const next of demoNextSteps(shown)) {
    io.stdout(`  # ${t(next.key)}`);
    io.stdout(`  ${shellLine(next.args)}`);
  }
  const other = t("demo.nextKo");
  io.stdout(`  # ${other}`);
  io.stdout(`  ${shellLine([...demoSteps(shown)[1]!, "--lang", lang === "ko" ? "en" : "ko"])}`);
  return 0;
}

// 직접 실행될 때만 CLI 로 동작한다(npm bin 은 심볼릭 링크라 실제 경로로 비교)
const entry = process.argv[1] ? safeRealpath(process.argv[1]) : "";
if (entry && entry === fileURLToPath(import.meta.url)) {
  exitQuietlyOnEpipe();
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`${String((err as Error)?.stack ?? err)}\n`);
      process.exitCode = 3;
    },
  );
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
