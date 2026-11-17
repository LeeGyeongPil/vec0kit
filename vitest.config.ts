import { defineConfig } from "vitest/config";

// 각 테스트는 OS 임시 폴더에 자기 DB 를 만들고 끝나면 지운다(test/helpers/fixtures.ts).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // better-sqlite3 네이티브 모듈은 스레드보다 프로세스 격리가 안전하다
    pool: "forks",
  },
});
