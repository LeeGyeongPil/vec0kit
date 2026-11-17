// vec0kit 라이브러리 공개 API. CLI 와 같은 함수를 앱 안에서 쓸 수 있다.
export { openDatabase, getVersions, TESTED_VEC_VERSION } from "./db.js";
export type { Database, OpenOptions, Versions } from "./db.js";
export {
  parseVec0Declaration,
  parseColumnDefinition,
  formatVec0Declaration,
  vectorColumns,
  keyColumn,
  effectiveMetric,
  LIMITS,
} from "./declaration.js";
export type {
  Vec0Declaration,
  Vec0Column,
  VectorColumn,
  PrimaryKeyColumn,
  PartitionColumn,
  MetadataColumn,
  AuxiliaryColumn,
  TableOption,
  ElementType,
  DistanceMetric,
  MetadataType,
} from "./declaration.js";
export { inspect, listVec0Tables } from "./inspect.js";
export type { InspectReport, Vec0TableInfo } from "./inspect.js";
export { check, exitCodeForReport, RULES } from "./check.js";
export type { CheckOptions, CheckReport, Finding, RuleId, Severity, SourceRef } from "./check.js";
export { planMigration, parseSourceSpec, tempTableName, STATE_TABLE, SKIPPED_TABLE } from "./plan.js";
export type { MigrationOptions, MigrationPlan, MigrationMode, SourceSpec, CopyColumn, InvalidVectors, PlanNote } from "./plan.js";
export { migrate, abortMigration } from "./migrate.js";
export type { MigrateOptions, MigrateProgress, MigrationResult, SkippedRows } from "./migrate.js";
export { verifyMigration } from "./verify.js";
export type { VerifyReport } from "./verify.js";
export { createMockEmbedder } from "./embedders/mock.js";
export { createOpenAIEmbedder } from "./embedders/openai.js";
export type { OpenAIEmbedderOptions } from "./embedders/openai.js";
export type { Embedder } from "./embedders/types.js";
export { Vec0KitError } from "./errors.js";
export type { Vec0KitErrorCode } from "./errors.js";
