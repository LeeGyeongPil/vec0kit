# Changelog

## 0.1.0 - 2026-11-17

First release.

- `vec0kit inspect`: lists `vec0` tables with vector columns (type, dimensions, distance), key, partition / metadata / auxiliary columns, options, row count and creating sqlite-vec version. Unknown options are preserved; unparsable declarations are an error.
- `vec0kit check`: rules `orphan-vector`, `missing-vector`, `zero-vector`, `non-finite`, `norm-drift`, `dim-mismatch`, `version-skew`, `untested-version`; exit codes for CI; `--json`.
- `vec0kit migrate`: change distance metric, dimensions (re-embed), quantization (int8 / bit), add or drop columns. Backup, temporary table, verification (row count, key set, values, sampled recall@k) and a swap without `RENAME` in one transaction. Resume after Ctrl-C, `--abort`, `--dry-run`, `--on-invalid`, `--min-recall`.
- Embedders: practice mock (feature hashing) and OpenAI-compatible `/embeddings` endpoints.
- `vec0kit demo` practice database, library API with type declarations, English and Korean output (`--lang`, `VEC0KIT_LANG`).
