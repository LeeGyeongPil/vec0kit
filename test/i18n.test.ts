// AC-9: 두 언어 — 사람용 출력은 고른 언어로, JSON 은 언어와 무관하게 같다
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES, createTranslator, resolveLang } from "../src/i18n/index.js";
import { HANGUL, cli, makeProblemDb, tempDir } from "./helpers/fixtures.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("AC-9 English and Korean", () => {
  it("en.json and ko.json have the same keys, no empty values and the same placeholders", () => {
    const en = MESSAGES.en;
    const ko = MESSAGES.ko;
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(en[key]!.trim(), key).not.toBe("");
      expect(ko[key]!.trim(), key).not.toBe("");
      expect(placeholders(ko[key]!), key).toEqual(placeholders(en[key]!));
    }
  });

  it("every rule has a message and a fix in both languages", () => {
    for (const rule of ["orphan-vector", "missing-vector", "zero-vector", "non-finite", "norm-drift", "dim-mismatch", "version-skew", "untested-version"]) {
      for (const lang of ["en", "ko"] as const) {
        expect(MESSAGES[lang][`rule.${rule}.message`]).toBeTruthy();
        expect(MESSAGES[lang][`rule.${rule}.fix`]).toBeTruthy();
      }
    }
  });

  it("--help is printed in the chosen language", async () => {
    for (const args of [["--help"], ["check", "--help"], ["migrate", "--help"], ["inspect", "--help"], ["demo", "--help"]]) {
      const ko = await cli([...args, "--lang", "ko"]);
      const en = await cli([...args, "--lang", "en"]);
      expect(ko.code).toBe(0);
      expect(en.code).toBe(0);
      expect(ko.stdout).toMatch(HANGUL);
      expect(en.stdout).not.toMatch(HANGUL);
    }
  });

  it("check output is Korean with --lang ko and English with --lang en; JSON is identical", async () => {
    const path = join(tempDir(), "p.db");
    makeProblemDb(path);
    const args = ["check", path, "--table", "vec_docs", "--source", "docs:id"];
    const ko = await cli([...args, "--lang", "ko"]);
    const en = await cli([...args, "--lang", "en"]);
    expect(ko.code).toBe(1);
    expect(en.code).toBe(1);
    expect(ko.stdout).toMatch(HANGUL);
    expect(ko.stdout).toContain("고치는 법");
    expect(en.stdout).not.toMatch(HANGUL);
    expect(en.stdout).toContain("Fix:");
    // 규칙 ID 는 두 언어 모두 그대로
    for (const out of [ko.stdout, en.stdout]) expect(out).toContain("orphan-vector");

    const jko = await cli([...args, "--json", "--lang", "ko"]);
    const jen = await cli([...args, "--json", "--lang", "en"]);
    expect(jko.stdout).toBe(jen.stdout);
    const ijko = await cli(["inspect", path, "--json"], { VEC0KIT_LANG: "ko" });
    const ijen = await cli(["inspect", path, "--json"], { VEC0KIT_LANG: "en" });
    expect(ijko.stdout).toBe(ijen.stdout);
    const pko = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "int8", "--no-backup", "--dry-run", "--json", "--lang", "ko"]);
    const pen = await cli(["migrate", path, "--table", "vec_docs", "--quantize", "int8", "--no-backup", "--dry-run", "--json", "--lang", "en"]);
    expect(pko.stdout).toBe(pen.stdout);
  });

  it("error messages follow the language too", async () => {
    const r = await cli(["migrate", join(tempDir(), "missing.db"), "--table", "t", "--quantize", "int8", "--lang", "ko"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(HANGUL);
  });

  it("resolves the language: --lang > VEC0KIT_LANG > LC_ALL > LC_MESSAGES > LANG, non-Korean → English", () => {
    expect(resolveLang("ko", { VEC0KIT_LANG: "en" })).toBe("ko");
    expect(resolveLang("en", { VEC0KIT_LANG: "ko" })).toBe("en");
    expect(resolveLang(undefined, { VEC0KIT_LANG: "ko", LC_ALL: "en_US.UTF-8" })).toBe("ko");
    expect(resolveLang(undefined, { VEC0KIT_LANG: "en", LANG: "ko_KR.UTF-8" })).toBe("en");
    expect(resolveLang(undefined, { LC_ALL: "ko_KR.UTF-8", LC_MESSAGES: "en_US", LANG: "en_US" })).toBe("ko");
    expect(resolveLang(undefined, { LC_ALL: "en_US.UTF-8", LANG: "ko_KR.UTF-8" })).toBe("en");
    expect(resolveLang(undefined, { LC_MESSAGES: "ko_KR", LANG: "en_US" })).toBe("ko");
    expect(resolveLang(undefined, { LC_MESSAGES: "C", LANG: "ko_KR" })).toBe("en");
    expect(resolveLang(undefined, { LANG: "ko_KR.UTF-8" })).toBe("ko");
    expect(resolveLang(undefined, { LANG: "ko" })).toBe("ko");
    expect(resolveLang(undefined, { LANG: "ja_JP.UTF-8" })).toBe("en");
    expect(resolveLang(undefined, { LANG: "kok_IN" })).toBe("en"); // 콘칸어는 한국어가 아니다
    expect(resolveLang(undefined, { LC_ALL: "" , LANG: "ko_KR" })).toBe("ko"); // 빈 값은 건너뛴다
    expect(resolveLang(undefined, {})).toBe("en");
  });

  it("the environment chooses the language when --lang is absent", async () => {
    const viaVec = await cli(["--help"], { VEC0KIT_LANG: "ko" });
    expect(viaVec.stdout).toMatch(HANGUL);
    const viaLang = await cli(["--help"], { LANG: "ko_KR.UTF-8" });
    expect(viaLang.stdout).toMatch(HANGUL);
    const viaLcAll = await cli(["--help"], { LC_ALL: "en_US.UTF-8", LANG: "ko_KR.UTF-8" });
    expect(viaLcAll.stdout).not.toMatch(HANGUL);
  });

  it("an unknown --lang is a usage error (exit 2)", async () => {
    const r = await cli(["--help", "--lang", "fr"]);
    expect(r.code).toBe(2);
  });

  it("the translator fills placeholders", () => {
    const t = createTranslator("ko");
    expect(t("check.summary", { error: 1, warn: 2, info: 3, code: 1 })).toBe("요약: 오류 1, 경고 2, 정보 3 → 종료 코드 1");
  });
});
