import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // DB-backed tests share one database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
